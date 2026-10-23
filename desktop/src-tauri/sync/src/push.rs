//! Pushes dirty rows in 22 §7.3 order. Notes use the server `rev` as CAS; a
//! replayed request is recognised by comparing the server copy, so no outbox
//! or write id is needed.
use crate::remote::{CallOptions, RemoteClient, RemoteError};
use crate::service::blocking;
use note_core::sync::{DirtyItem, LocalRow};
use note_core::{AppError, DirtyEntity, ErrorCode, Folder, Library, Note, Tag};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;

/// Failures that end the round: the remaining rows would fail the same way.
fn ends_round(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::Unauthenticated
            | ErrorCode::Forbidden
            | ErrorCode::Offline
            | ErrorCode::RequestTimeout
            | ErrorCode::TooManyAttempts
            | ErrorCode::StorageUnavailable
            | ErrorCode::Internal
            | ErrorCode::Cancelled
    )
}

/// Pushes every dirty row once. A row rejected by the server (other 4xx) is
/// skipped so it cannot block the rest; the round then reports its code.
///
/// # Errors
/// Returns the first round-ending error, else the first skipped row's error.
pub async fn push(
    library: &Arc<Library>,
    remote: &RemoteClient,
    opts: &CallOptions,
) -> Result<(), AppError> {
    let items = blocking(library, Library::sync_dirty).await?;
    let mut skipped: Option<AppError> = None;
    for item in items {
        if opts.cancel.is_cancelled() {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "Synchronization cancelled",
            ));
        }
        if let Err(error) = push_one(library, remote, &item, opts).await {
            if ends_round(error.code()) {
                return Err(error);
            }
            tracing::warn!(
                entity = item.entity_name(),
                code = error.code().as_str(),
                "sync.push.skipped"
            );
            skipped.get_or_insert(error);
        }
    }
    skipped.map_or(Ok(()), Err)
}

trait EntityName {
    fn entity_name(&self) -> &'static str;
}
impl EntityName for DirtyItem {
    fn entity_name(&self) -> &'static str {
        match self.entity {
            DirtyEntity::Note => "note",
            DirtyEntity::Folder => "folder",
            DirtyEntity::Tag => "tag",
        }
    }
}

async fn settle(
    library: &Arc<Library>,
    item: &DirtyItem,
    remote_rev: Option<i64>,
) -> Result<(), AppError> {
    let (entity, id, seen) = (item.entity, item.id.clone(), item.seen.clone());
    blocking(library, move |lib| {
        lib.sync_settle(entity, &id, remote_rev, &seen)
    })
    .await
}

fn app(error: RemoteError) -> AppError {
    error.app_error()
}
/// A missing remote row is already in the state a deletion wants.
fn gone_ok<T>(result: Result<T, RemoteError>) -> Result<(), AppError> {
    match result {
        Ok(_) => Ok(()),
        Err(error) if error.code == ErrorCode::NotFound => Ok(()),
        Err(error) => Err(app(error)),
    }
}

async fn push_one(
    library: &Arc<Library>,
    remote: &RemoteClient,
    item: &DirtyItem,
    opts: &CallOptions,
) -> Result<(), AppError> {
    match &item.row {
        LocalRow::Note(local) => push_note(library, remote, item, local, opts).await,
        LocalRow::Folder(folder) => {
            push_folder(remote, folder, opts).await?;
            settle(library, item, None).await
        }
        LocalRow::Tag(tag) => push_tag(library, remote, item, tag, opts).await,
        LocalRow::Missing => {
            match item.entity {
                // Purged locally: the remote purge only accepts a trashed note.
                DirtyEntity::Note if item.remote_rev.is_some() => {
                    gone_ok(remote.trash_note(&item.id, opts).await)?;
                    gone_ok(remote.purge_note(&item.id, opts).await)?;
                }
                DirtyEntity::Note => {}
                DirtyEntity::Folder => gone_ok(
                    remote
                        .metadata_write("folders", Some(&item.id), Method::DELETE, None, opts)
                        .await,
                )?,
                DirtyEntity::Tag => gone_ok(
                    remote
                        .metadata_write("tags", Some(&item.id), Method::DELETE, None, opts)
                        .await,
                )?,
            }
            settle(library, item, None).await
        }
    }
}

/// Every user-visible field except the trash state.
fn same_body(a: &Note, b: &Note) -> bool {
    a.content == b.content
        && a.summary.title == b.summary.title
        && a.summary.folder_id == b.summary.folder_id
        && a.summary.is_pinned == b.summary.is_pinned
        && a.summary.is_starred == b.summary.is_starred
        && a.summary.is_archived == b.summary.is_archived
}
/// The fields `POST /api/notes` sets.
fn same_created(a: &Note, b: &Note) -> bool {
    a.content == b.content
        && a.summary.title == b.summary.title
        && a.summary.folder_id == b.summary.folder_id
        && a.summary.is_starred == b.summary.is_starred
}

fn patch_body(note: &Note, rev: i64) -> Value {
    json!({
        "rev": rev,
        "title": note.summary.title,
        "content": note.content,
        "folderId": note.summary.folder_id,
        "isPinned": note.summary.is_pinned,
        "isStarred": note.summary.is_starred,
        "isArchived": note.summary.is_archived,
    })
}

async fn push_note(
    library: &Arc<Library>,
    remote: &RemoteClient,
    item: &DirtyItem,
    local: &Note,
    opts: &CallOptions,
) -> Result<(), AppError> {
    let transport = crate::attachments::prepare_note(library, remote, local, opts)
        .await
        .map_err(|error| error.app_error())?;
    let id = item.id.as_str();
    let mut saved = match item.remote_rev {
        Some(rev) => match remote
            .patch_note(id, patch_body(&transport, rev), opts)
            .await
        {
            Ok(saved) => saved,
            Err(error) if error.code == ErrorCode::Conflict => {
                let server = *error
                    .server
                    .ok_or_else(|| error_of(ErrorCode::InvalidResponse))?;
                if !same_body(&transport, &server) {
                    return fork(library, remote, item, &server, opts).await;
                }
                // The earlier request already landed; only the trash state may remain.
                server
            }
            // Deleted remotely but edited here: the local version is recreated (§7.3).
            Err(error) if error.code == ErrorCode::NotFound => {
                create(remote, &transport, opts).await?
            }
            Err(error) => return Err(app(error)),
        },
        None => create(remote, &transport, opts).await?,
    };
    if !same_body(&transport, &saved) {
        // POST with an id the account already has returns that note unchanged:
        // when even the POSTed fields differ, keep both instead of overwriting it.
        if item.remote_rev.is_none() && !same_created(&transport, &saved) {
            return fork(library, remote, item, &saved, opts).await;
        }
        saved = remote
            .patch_note(id, patch_body(&transport, saved.summary.rev.get()), opts)
            .await
            .map_err(app)?;
    }
    let trashed = local.summary.deleted_at.is_some();
    if trashed && saved.summary.deleted_at.is_none() {
        saved = remote.trash_note(id, opts).await.map_err(app)?;
    } else if !trashed && saved.summary.deleted_at.is_some() {
        saved = remote
            .restore_note(id, json!({}), opts)
            .await
            .map_err(app)?;
    }
    settle(library, item, Some(saved.summary.rev.get())).await
}

async fn create(remote: &RemoteClient, note: &Note, opts: &CallOptions) -> Result<Note, AppError> {
    remote
        .create_note(
            json!({
                "id": note.summary.id,
                "title": note.summary.title,
                "content": note.content,
                "folderId": note.summary.folder_id,
                "isStarred": note.summary.is_starred,
            }),
            opts,
        )
        .await
        .map_err(app)
}

/// Real conflict: keep the local version as a pending copy, adopt the server version.
async fn fork(
    library: &Arc<Library>,
    remote: &RemoteClient,
    item: &DirtyItem,
    server: &Note,
    opts: &CallOptions,
) -> Result<(), AppError> {
    let server = crate::attachments::materialize_note(library, remote, server, opts)
        .await
        .map_err(|error| error.app_error())?;
    let seen = item.seen.clone();
    // `false` means the note changed meanwhile; the next round retries with fresh state.
    blocking(library, move |lib| lib.sync_fork_conflict(&server, &seen)).await?;
    Ok(())
}

fn error_of(code: ErrorCode) -> AppError {
    AppError::new(code, "Remote synchronization request failed")
}

/// Folders are last-writer-wins (§7.4): update, or create when the remote lacks it.
async fn push_folder(
    remote: &RemoteClient,
    folder: &Folder,
    opts: &CallOptions,
) -> Result<(), AppError> {
    let body = json!({
        "name": folder.name,
        "parentId": folder.parent_id,
        "icon": folder.icon,
        "color": folder.color,
    });
    match remote
        .metadata_write(
            "folders",
            Some(folder.id.as_str()),
            Method::PATCH,
            Some(body.clone()),
            opts,
        )
        .await
    {
        Ok(_) => Ok(()),
        Err(error) if error.code == ErrorCode::NotFound => {
            let mut create = body;
            create["id"] = json!(folder.id);
            remote
                .metadata_write("folders", None, Method::POST, Some(create), opts)
                .await
                .map(|_| ())
                .map_err(app)
        }
        Err(error) => Err(app(error)),
    }
}

/// Manual tags (§7.4). A name the remote already uses means the same tag: adopt its id.
async fn push_tag(
    library: &Arc<Library>,
    remote: &RemoteClient,
    item: &DirtyItem,
    tag: &Tag,
    opts: &CallOptions,
) -> Result<(), AppError> {
    let body = json!({ "name": tag.name, "color": tag.color });
    let result = match remote
        .metadata_write(
            "tags",
            Some(tag.id.as_str()),
            Method::PATCH,
            Some(body.clone()),
            opts,
        )
        .await
    {
        Err(error) if error.code == ErrorCode::NotFound => {
            let mut create = body;
            create["id"] = json!(tag.id);
            remote
                .metadata_write("tags", None, Method::POST, Some(create), opts)
                .await
        }
        other => other,
    };
    match result {
        Ok(_) => settle(library, item, None).await,
        Err(error) if error.code == ErrorCode::Conflict => {
            let existing = remote
                .list_tags(opts)
                .await
                .map_err(app)?
                .into_iter()
                .find(|remote_tag| remote_tag.name.eq_ignore_ascii_case(&tag.name))
                .ok_or_else(|| app(error))?;
            let local = tag.id.to_string();
            blocking(library, move |lib| lib.sync_adopt_tag(&local, &existing)).await
        }
        Err(error) => Err(app(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_is_recognised_by_body_not_trash_state() -> Result<(), serde_json::Error> {
        let value = json!({"id":"00000000000000000000000001","title":"t","content":"body","excerpt":"","folderId":null,"tags":[],"isPinned":false,"isStarred":false,"isArchived":false,"wordCount":1,"charCount":4,"rev":3,"position":0,"createdAt":1,"updatedAt":1,"deletedAt":null});
        let sent: Note = serde_json::from_value(value)?;
        let mut server = sent.clone();
        server.summary.deleted_at =
            Some(note_core::Millis::new(5).unwrap_or(sent.summary.updated_at));
        assert!(same_body(&sent, &server));
        server.content = "edited elsewhere".into();
        assert!(!same_body(&sent, &server));
        assert!(ends_round(ErrorCode::Offline));
        assert!(!ends_round(ErrorCode::BadRequest));
        Ok(())
    }
}
