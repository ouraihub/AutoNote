//! Replay only frozen, epoch-scoped writes; a successful HTTP status is not an ACK.
use crate::remote::{CallOptions, RemoteClient, RemoteError};
use crate::service::blocking;
use note_core::sync::{Binding, OutboxItem, OutboxKind, OutboxState, SyncEntity};
use note_core::{AppError, ErrorCode, FolderId, Library, Note};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;

enum Failure {
    Remote(RemoteError),
    Local(AppError),
    Blocked(&'static str),
}
impl From<RemoteError> for Failure {
    fn from(error: RemoteError) -> Self {
        Self::Remote(error)
    }
}
impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Self::Local(error)
    }
}

/// Replays pending outbound writes for the binding.
///
/// # Errors
/// Returns a synchronization, cancellation, remote, or local transaction error.
pub async fn push(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    opts: &CallOptions,
) -> Result<(), AppError> {
    // ponytail: one serial batch, let the existing engine schedule the remaining queue.
    for _ in 0..64 {
        if opts.cancel.is_cancelled() {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "Synchronization cancelled",
            ));
        }
        let b = binding.clone();
        let Some(item) = blocking(library, move |library| library.sync_claim_outbox(&b, 1))
            .await?
            .into_iter()
            .next()
        else {
            return Ok(());
        };
        match send_item(library, remote, binding, opts, &item).await {
            Ok(()) => {}
            Err(Failure::Blocked(reason)) => {
                set_state(library, binding, &item, OutboxState::Blocked, reason).await?;
                return Err(AppError::new(ErrorCode::Conflict, reason));
            }
            Err(Failure::Local(error)) => {
                // A failed local commit never becomes a remote success; retain this write.
                let _ = set_state(
                    library,
                    binding,
                    &item,
                    OutboxState::Pending,
                    error.code().as_str(),
                )
                .await;
                return Err(error);
            }
            Err(Failure::Remote(error)) => {
                match error.code {
                    ErrorCode::Cancelled => {
                        set_state(library, binding, &item, OutboxState::Pending, "cancelled")
                            .await?
                    }
                    ErrorCode::Unauthenticated
                    | ErrorCode::TooManyAttempts
                    | ErrorCode::Offline
                    | ErrorCode::RequestTimeout
                    | ErrorCode::StorageUnavailable
                    | ErrorCode::Internal => {
                        let delay = error
                            .retry_after
                            .unwrap_or_else(|| 1_u64 << item.attempt_count.clamp(0, 8))
                            .clamp(1, 300);
                        let at = crate::remote::now()?
                            .get()
                            .saturating_add((delay * 1000) as i64)
                            .min(note_core::MAX_SAFE_INTEGER);
                        let b = binding.clone();
                        let id = item.write_id.clone();
                        let code = error.code.as_str();
                        blocking(library, move |library| {
                            library.sync_defer_outbox(&b, &id, at, code)
                        })
                        .await?;
                    }
                    _ => {
                        set_state(
                            library,
                            binding,
                            &item,
                            OutboxState::Blocked,
                            error.code.as_str(),
                        )
                        .await?
                    }
                }
                return Err(error.app_error());
            }
        }
    }
    Ok(())
}

async fn set_state(
    library: &Arc<Library>,
    binding: &Binding,
    item: &OutboxItem,
    state: OutboxState,
    code: &'static str,
) -> Result<(), AppError> {
    let b = binding.clone();
    let id = item.write_id.clone();
    blocking(library, move |library| {
        library.sync_error_outbox(&b, &id, state, code)
    })
    .await
}

async fn prerequisites(
    library: &Arc<Library>,
    binding: &Binding,
    item: &OutboxItem,
) -> Result<(), Failure> {
    if item.binding_id != binding.binding_id
        || item.binding_epoch != binding.binding_epoch
        || item.sent_local_rev != Some(item.local_rev)
    {
        return Err(Failure::Blocked("ack_prerequisite_missing"));
    }
    let b = binding.clone();
    let id = item.write_id.clone();
    if !blocking(library, move |library| {
        library.sync_ack_prerequisites(&b, &id)
    })
    .await?
    {
        return Err(Failure::Blocked("ack_prerequisite_missing"));
    }
    Ok(())
}

async fn mapped_id(
    library: &Arc<Library>,
    binding: &Binding,
    entity: SyncEntity,
    local: &str,
) -> Result<Option<String>, Failure> {
    let b = binding.clone();
    let local = local.to_owned();
    Ok(blocking(library, move |library| {
        library.sync_map_for_local(&b, entity, &local)
    })
    .await?
    .map(|map| map.remote_id))
}

async fn ack(
    library: &Arc<Library>,
    binding: &Binding,
    item: &OutboxItem,
    id: &str,
    rev: Option<i64>,
) -> Result<(), Failure> {
    let b = binding.clone();
    let write = item.write_id.clone();
    let id = id.to_owned();
    let sent = item
        .sent_local_rev
        .ok_or(Failure::Blocked("frozen_revision_missing"))?;
    blocking(library, move |library| {
        library.sync_ack_outbox(&b, &write, sent, &id, rev)
    })
    .await?;
    Ok(())
}

async fn send_item(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    opts: &CallOptions,
    item: &OutboxItem,
) -> Result<(), Failure> {
    match item.entity {
        SyncEntity::Note if item.kind != OutboxKind::Metadata => {
            send_note(library, remote, binding, opts, item).await
        }
        SyncEntity::Folder | SyncEntity::Tag => {
            send_metadata(library, remote, binding, opts, item).await
        }
        _ => Err(Failure::Blocked("unsupported_outbox_kind")),
    }
}

fn note_body(note: &Note) -> Value {
    json!({"title":note.summary.title,"content":note.content,"folderId":note.summary.folder_id,"isStarred":note.summary.is_starred,"isPinned":note.summary.is_pinned,"isArchived":note.summary.is_archived})
}
fn matches_note(expected: &Note, saved: &Note, id: &str, kind: OutboxKind) -> bool {
    let deleted = match kind {
        OutboxKind::Trash => true,
        OutboxKind::Restore => false,
        _ => expected.summary.deleted_at.is_some(),
    };
    saved.summary.id.as_str() == id
        && expected.content == saved.content
        && expected.summary.title == saved.summary.title
        && expected.summary.folder_id == saved.summary.folder_id
        && expected.summary.is_starred == saved.summary.is_starred
        && expected.summary.is_pinned == saved.summary.is_pinned
        && expected.summary.is_archived == saved.summary.is_archived
        && saved.summary.deleted_at.is_some() == deleted
}
fn matches_create(expected: &Note, saved: &Note, id: &str) -> bool {
    saved.summary.id.as_str() == id
        && expected.content == saved.content
        && expected.summary.title == saved.summary.title
        && expected.summary.folder_id == saved.summary.folder_id
        && expected.summary.is_starred == saved.summary.is_starred
        && saved.summary.deleted_at.is_none()
}

async fn rebase(
    library: &Arc<Library>,
    binding: &Binding,
    item: &OutboxItem,
    server: &Note,
) -> Result<(), Failure> {
    let b = binding.clone();
    let id = item.write_id.clone();
    let server = server.clone();
    blocking(library, move |library| {
        library.sync_rebase_outbox(&b, &id, server.summary.rev.get(), &server)
    })
    .await?;
    Ok(())
}

async fn send_note(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    opts: &CallOptions,
    item: &OutboxItem,
) -> Result<(), Failure> {
    let mut desired: Note = serde_json::from_value(item.payload.clone())
        .map_err(|_| Failure::Blocked("invalid_note_snapshot"))?;
    if let Some(local) = &desired.summary.folder_id {
        let id = mapped_id(library, binding, SyncEntity::Folder, local.as_str())
            .await?
            .ok_or(Failure::Blocked("folder_mapping_missing"))?;
        desired.summary.folder_id = Some(FolderId::new(id).map_err(AppError::from)?);
    }
    desired = crate::attachments::prepare_note(library, remote, binding, &desired, opts)
        .await
        .map_err(|error| Failure::Local(error.app_error()))?;
    prerequisites(library, binding, item).await?;
    let local = item
        .local_id
        .as_deref()
        .ok_or(Failure::Blocked("note_id_missing"))?;
    let mapped = mapped_id(library, binding, SyncEntity::Note, local).await?;
    let mut id = item
        .recovery_id
        .clone()
        .or(mapped)
        .unwrap_or_else(|| local.to_owned());
    let mut create = item.kind == OutboxKind::Create || item.recovery_id.is_some();
    let mut rev = item.base_remote_rev;
    let mut preserve = item
        .payload
        .get("preserveVersion")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    for _ in 0..3 {
        prerequisites(library, binding, item).await?;
        let result = if create {
            let mut body = note_body(&desired);
            body["id"] = json!(id);
            // Worker POST accepts only this subset; remaining flags are persisted by PATCH below.
            body.as_object_mut()
                .ok_or(Failure::Blocked("invalid_note_snapshot"))?
                .remove("isPinned");
            body.as_object_mut()
                .ok_or(Failure::Blocked("invalid_note_snapshot"))?
                .remove("isArchived");
            match remote.create_note(body, opts).await {
                Ok(mut saved) => {
                    if !matches_create(&desired, &saved, &id) {
                        return Err(Failure::Blocked("idempotent_create_mismatch"));
                    }
                    if desired.summary.is_pinned != saved.summary.is_pinned
                        || desired.summary.is_archived != saved.summary.is_archived
                    {
                        let mut body = note_body(&desired);
                        body["rev"] = json!(saved.summary.rev.get());
                        body["preserveVersion"] = json!(true);
                        saved = remote.patch_note(&id, body, opts).await?;
                    }
                    if item.kind == OutboxKind::Trash {
                        saved = remote.trash_note(&id, opts).await?;
                    }
                    Ok(saved)
                }
                Err(error) => Err(error),
            }
        } else if item.kind == OutboxKind::Patch {
            let mut body = note_body(&desired);
            body["rev"] = json!(
                rev.filter(|rev| *rev > 0)
                    .ok_or(Failure::Blocked("remote_revision_missing"))?
            );
            body["preserveVersion"] = json!(preserve);
            remote.patch_note(&id, body, opts).await
        } else {
            // These Worker endpoints have no client CAS. Verify known state, without claiming atomicity.
            match remote.get_note(&id, opts).await {
                Ok(server) => {
                    if item.kind == OutboxKind::Purge {
                        if server.summary.deleted_at.is_none() {
                            return Err(Failure::Blocked("purge_requires_trash"));
                        }
                        let response = remote.purge_note(&id, opts).await?;
                        if response.get("ok").and_then(Value::as_bool) != Some(true) {
                            return Err(Failure::Blocked("invalid_purge_response"));
                        }
                        return ack(library, binding, item, &id, None).await;
                    }
                    if matches_note(&desired, &server, &id, item.kind) {
                        return ack(library, binding, item, &id, Some(server.summary.rev.get()))
                            .await;
                    }
                    if rev != Some(server.summary.rev.get()) {
                        rebase(library, binding, item, &server).await?;
                        rev = Some(server.summary.rev.get());
                    }
                    match item.kind {
                        OutboxKind::Trash => remote.trash_note(&id, opts).await,
                        OutboxKind::Restore => {
                            remote.restore_note(&id, json!({"rev":rev}), opts).await
                        }
                        _ => return Err(Failure::Blocked("unsupported_outbox_kind")),
                    }
                }
                Err(error) => Err(error),
            }
        };
        match result {
            Ok(saved) => {
                if !matches_note(&desired, &saved, &id, item.kind) {
                    return Err(Failure::Blocked("note_ack_content_mismatch"));
                }
                return ack(library, binding, item, &id, Some(saved.summary.rev.get())).await;
            }
            Err(error) if error.code == ErrorCode::Conflict => {
                let server = error
                    .server
                    .ok_or(Failure::Blocked("conflict_server_missing"))?;
                if server.summary.id.as_str() != id {
                    return Err(Failure::Blocked("conflict_server_id_mismatch"));
                }
                if matches_note(&desired, &server, &id, item.kind) {
                    return ack(library, binding, item, &id, Some(server.summary.rev.get())).await;
                }
                if create {
                    return Err(Failure::Blocked("idempotent_create_mismatch"));
                }
                rebase(library, binding, item, &server).await?;
                rev = Some(server.summary.rev.get());
                preserve = true;
            }
            Err(error) if error.code == ErrorCode::NotFound => {
                if item.kind == OutboxKind::Purge {
                    return ack(library, binding, item, &id, None).await;
                }
                let b = binding.clone();
                let write = item.write_id.clone();
                id = blocking(library, move |library| {
                    library.sync_mark_recovery(&b, &write)
                })
                .await?;
                create = true;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(RemoteError::new(ErrorCode::StorageUnavailable).into())
}

async fn send_metadata(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    opts: &CallOptions,
    item: &OutboxItem,
) -> Result<(), Failure> {
    let method = match item.payload.get("method").and_then(Value::as_str) {
        Some("POST") => Method::POST,
        Some("PATCH") => Method::PATCH,
        Some("DELETE") => Method::DELETE,
        _ => return Err(Failure::Blocked("unsupported_metadata_method")),
    };
    if item.kind != OutboxKind::Metadata {
        return Err(Failure::Blocked("unsupported_outbox_kind"));
    }
    let entity = match item.entity {
        SyncEntity::Folder => "folders",
        SyncEntity::Tag => "tags",
        _ => return Err(Failure::Blocked("unsupported_outbox_kind")),
    };
    let local = item
        .local_id
        .as_deref()
        .ok_or(Failure::Blocked("metadata_id_missing"))?;
    let mapped = mapped_id(library, binding, item.entity.clone(), local).await?;
    let id = mapped.unwrap_or_else(|| local.to_owned());
    // Fresh complete collections are required immediately before comparing the queued base.
    let latest: Vec<Value> = if item.entity == SyncEntity::Folder {
        remote
            .list_folders(opts)
            .await?
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<_, _>>()
    } else {
        remote
            .list_tags(opts)
            .await?
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<_, _>>()
    }
    .map_err(|_| Failure::Blocked("invalid_metadata_response"))?;
    let latest = latest
        .into_iter()
        .find(|value| value.get("id").and_then(Value::as_str) == Some(&id))
        .unwrap_or(Value::Null);
    let b = binding.clone();
    let write = item.write_id.clone();
    if !blocking(library, move |library| {
        library.sync_metadata_guard(&b, &write, &latest)
    })
    .await?
    {
        return Err(Failure::Blocked("metadata_conflict"));
    }
    prerequisites(library, binding, item).await?;
    let mut input = item
        .payload
        .get("input")
        .cloned()
        .ok_or(Failure::Blocked("metadata_input_missing"))?;
    if method != Method::DELETE && !input.is_object() {
        return Err(Failure::Blocked("invalid_metadata_input"));
    }
    if item.entity == SyncEntity::Folder {
        for field in ["parentId", "beforeId"] {
            if let Some(local) = input.get(field).and_then(Value::as_str) {
                let remote = mapped_id(library, binding, SyncEntity::Folder, local)
                    .await?
                    .ok_or(Failure::Blocked("folder_mapping_missing"))?;
                input[field] = json!(remote);
            }
        }
    }
    if method == Method::POST {
        input["id"] = json!(id);
    }
    if input.get("expected_updated_at").is_some() || input.get("expectedUpdatedAt").is_some() {
        return Err(Failure::Blocked("metadata_cas_unsupported"));
    }
    let response = remote
        .metadata_write(
            entity,
            if method == Method::POST {
                None
            } else {
                Some(&id)
            },
            method.clone(),
            if method == Method::DELETE {
                None
            } else {
                Some(input.clone())
            },
            opts,
        )
        .await?;
    if method == Method::DELETE {
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(Failure::Blocked("invalid_metadata_response"));
        }
    } else if !matches_metadata(&input, &response, &id) {
        return Err(Failure::Blocked("metadata_ack_content_mismatch"));
    }
    let at = crate::remote::now()?.get();
    let b = binding.clone();
    let write = item.write_id.clone();
    let sent = item
        .sent_local_rev
        .ok_or(Failure::Blocked("frozen_revision_missing"))?;
    blocking(library, move |library| {
        library.sync_ack_metadata(&b, &write, sent, &id, &response, at)
    })
    .await?;
    Ok(())
}
fn matches_metadata(input: &Value, response: &Value, id: &str) -> bool {
    response.get("id").and_then(Value::as_str) == Some(id)
        && input.as_object().is_some_and(|fields| {
            fields.iter().all(|(key, value)| {
                key == "id" || key == "beforeId" || response.get(key) == Some(value)
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ack_requires_the_frozen_content_and_target() -> Result<(), serde_json::Error> {
        let value = json!({"id":"00000000000000000000000001","title":"frozen","content":"old write","excerpt":"","folderId":null,"tags":[],"isPinned":false,"isStarred":false,"isArchived":false,"wordCount":2,"charCount":9,"rev":1,"position":0,"createdAt":1,"updatedAt":1,"deletedAt":null});
        let frozen: Note = serde_json::from_value(value)?;
        let mut response = frozen.clone();
        assert!(matches_note(
            &frozen,
            &response,
            frozen.summary.id.as_str(),
            OutboxKind::Patch
        ));
        response.content = "newer input".into();
        assert!(!matches_note(
            &frozen,
            &response,
            frozen.summary.id.as_str(),
            OutboxKind::Patch
        ));
        assert!(!matches_create(
            &frozen,
            &response,
            frozen.summary.id.as_str()
        ));
        assert!(!matches_note(
            &frozen,
            &frozen,
            "00000000000000000000000002",
            OutboxKind::Patch
        ));
        assert!(!matches_note(
            &frozen,
            &frozen,
            frozen.summary.id.as_str(),
            OutboxKind::Trash
        ));
        Ok(())
    }
}
