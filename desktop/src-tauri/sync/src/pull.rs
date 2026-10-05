//! Summary pages are checkpoints only after every body and attachment is ready.
use crate::{
    remote::{CallOptions, RemoteClient, RemoteError},
    service::blocking,
};
use note_core::sync::Binding;
use note_core::{
    AppError, DeletedEntity, ErrorCode, Folder, FolderId, Library, Note, NoteId, SyncDeletion,
    SyncResponse, Tag, TagId,
};
use std::{collections::BTreeMap, sync::Arc};

const ATTEMPTS: usize = 3;

pub struct CollectedSnapshot {
    pub notes: Vec<Note>,
    pub page: SyncResponse,
}

fn invalid() -> RemoteError {
    RemoteError::new(ErrorCode::InvalidResponse)
}
fn check(opts: &CallOptions) -> Result<(), RemoteError> {
    if opts.cancel.is_cancelled() {
        return Err(RemoteError::new(ErrorCode::Cancelled));
    }
    if std::time::Instant::now() >= opts.deadline {
        return Err(RemoteError::new(ErrorCode::RequestTimeout));
    }
    Ok(())
}

fn validate(
    page: &SyncResponse,
    since: i64,
    after: Option<&str>,
    snapshot: Option<i64>,
) -> Result<(), RemoteError> {
    if page.notes.iter().any(|note| !note.position.is_finite())
        || page
            .folders
            .iter()
            .any(|folder| !folder.position.is_finite())
    {
        return Err(invalid());
    }
    for deletion in &page.deletions {
        let valid = match deletion.entity {
            DeletedEntity::Note => NoteId::new(deletion.id.clone()).is_ok(),
            DeletedEntity::Folder => FolderId::new(deletion.id.clone()).is_ok(),
            DeletedEntity::Tag => TagId::new(deletion.id.clone()).is_ok(),
        };
        if !valid {
            return Err(invalid());
        }
    }
    if page.full {
        if !page.facets_full || snapshot.is_some_and(|cursor| cursor != page.cursor.get()) {
            return Err(invalid());
        }
        let mut previous = after.unwrap_or("");
        for note in &page.notes {
            if note.id.as_str() <= previous {
                return Err(invalid());
            }
            previous = note.id.as_str();
        }
        if page.has_more {
            if page.notes.is_empty()
                || page.next_key.as_deref() != Some(previous)
                || previous.len() > 128
            {
                return Err(invalid());
            }
        } else if page.next_key.is_some() {
            return Err(invalid());
        }
    } else if after.is_some()
        || page.next_key.is_some()
        || page.cursor.get() < since
        || page.has_more && page.cursor.get() <= since
    {
        return Err(invalid());
    }
    Ok(())
}

/// Re-fetch this exact page when a GET observes a newer revision. Nothing from
/// the mismatched page is applied, including its cursor or metadata.
async fn ready_page(
    remote: &RemoteClient,
    since: i64,
    after: Option<&str>,
    snapshot: Option<i64>,
    opts: &CallOptions,
) -> Result<CollectedSnapshot, RemoteError> {
    for _ in 0..ATTEMPTS {
        check(opts)?;
        let mut page = remote.sync_page(since, after, snapshot, opts).await?;
        validate(&page, since, after, snapshot)?;
        let mut notes = Vec::with_capacity(page.notes.len());
        let mut missing = Vec::new();
        let mut changed = false;
        for summary in &page.notes {
            match remote.get_note(summary.id.as_str(), opts).await {
                Ok(note) => {
                    if note.summary.id != summary.id || note.summary.rev < summary.rev {
                        return Err(invalid());
                    }
                    if note.summary.rev != summary.rev {
                        changed = true;
                        break;
                    }
                    notes.push(note);
                }
                Err(error) if error.code == ErrorCode::NotFound => missing.push(summary.id.clone()),
                Err(error) => return Err(error),
            }
        }
        if changed {
            continue;
        }
        page.notes.retain(|summary| !missing.contains(&summary.id));
        for id in missing {
            if !page.deletions.iter().any(|deletion| {
                deletion.entity == DeletedEntity::Note && deletion.id == id.as_str()
            }) {
                page.deletions.push(SyncDeletion {
                    entity: DeletedEntity::Note,
                    id: id.to_string(),
                });
            }
        }
        return Ok(CollectedSnapshot { notes, page });
    }
    Err(invalid())
}

fn empty_zero(page: &SyncResponse) -> bool {
    page.full
        && page.cursor.get() == 0
        && !page.has_more
        && page.notes.is_empty()
        && page.folders.is_empty()
        && page.tags.is_empty()
        && page.deletions.is_empty()
}

/// Pure binding preview: all real bodies, a full page chain, and its catch-up.
/// No library, attachment materialization, checkpoint or outbox writes.
/// # Errors
/// Returns cancellation, network, invalid page/body or exhausted snapshot-restart errors.
pub async fn collect(
    remote: &RemoteClient,
    opts: &CallOptions,
) -> Result<CollectedSnapshot, RemoteError> {
    for _ in 0..ATTEMPTS {
        let first = ready_page(remote, 0, None, None, opts).await?;
        if !first.page.full {
            return Err(invalid());
        }
        let snapshot = first.page.cursor.get();
        let mut notes = BTreeMap::new();
        let mut folders = BTreeMap::new();
        let mut tags = BTreeMap::new();
        let mut result = first.page;
        for note in first.notes {
            notes.insert(note.summary.id.clone(), note);
        }
        for folder in std::mem::take(&mut result.folders) {
            folders.insert(folder.id.clone(), folder);
        }
        for tag in std::mem::take(&mut result.tags) {
            tags.insert(tag.id.clone(), tag);
        }
        for deletion in &result.deletions {
            if deletion.entity == DeletedEntity::Note {
                notes.retain(|id, _| id.as_str() != deletion.id);
            }
        }
        let mut after = result.next_key.clone();
        while let Some(key) = after {
            let next = ready_page(remote, 0, Some(&key), Some(snapshot), opts).await?;
            after = next.page.next_key.clone();
            absorb(
                &mut notes,
                &mut folders,
                &mut tags,
                next,
                false,
                &mut result,
            );
        }
        let mut cursor = snapshot;
        loop {
            let next = ready_page(remote, cursor, None, None, opts).await?;
            if next.page.full {
                // The Worker always returns full for since=0. A second empty
                // zero snapshot is the only full response needing no restart.
                if cursor == 0 && empty_zero(&next.page) {
                    return Ok(next);
                }
                break;
            }
            cursor = next.page.cursor.get();
            let more = next.page.has_more;
            absorb(&mut notes, &mut folders, &mut tags, next, true, &mut result);
            if !more {
                result.full = true;
                result.has_more = false;
                result.next_key = None;
                result.facets_full = true;
                result.notes = notes.values().map(|note| note.summary.clone()).collect();
                result.folders = folders.into_values().collect();
                result.tags = tags.into_values().collect();
                result.deletions.clear();
                return Ok(CollectedSnapshot {
                    notes: notes.into_values().collect(),
                    page: result,
                });
            }
        }
    }
    Err(invalid())
}

fn absorb(
    notes: &mut BTreeMap<NoteId, Note>,
    folders: &mut BTreeMap<FolderId, Folder>,
    tags: &mut BTreeMap<TagId, Tag>,
    next: CollectedSnapshot,
    facets: bool,
    result: &mut SyncResponse,
) {
    let page = next.page;
    for note in next.notes {
        notes.insert(note.summary.id.clone(), note);
    }
    if facets {
        if page.facets_full {
            folders.clear();
            tags.clear();
        }
        for folder in page.folders {
            folders.insert(folder.id.clone(), folder);
        }
        for tag in page.tags {
            tags.insert(tag.id.clone(), tag);
        }
    }
    for deletion in page.deletions {
        match deletion.entity {
            DeletedEntity::Note => {
                notes.retain(|id, _| id.as_str() != deletion.id);
            }
            DeletedEntity::Folder => {
                folders.retain(|id, _| id.as_str() != deletion.id);
            }
            DeletedEntity::Tag => {
                tags.retain(|id, _| id.as_str() != deletion.id);
            }
        }
    }
    result.cursor = page.cursor;
    result.has_more = page.has_more;
    result.next_key = page.next_key;
    result.server_time = page.server_time;
    result.settings_changed |= page.settings_changed;
    result.profile_changed =
        Some(result.profile_changed == Some(true) || page.profile_changed == Some(true));
    result.site_changed =
        Some(result.site_changed == Some(true) || page.site_changed == Some(true));
}

async fn materialize(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    notes: &mut [Note],
    opts: &CallOptions,
) -> Result<(), AppError> {
    for note in notes {
        check(opts).map_err(|error| error.app_error())?;
        *note = crate::attachments::materialize_note(library, remote, binding, note, opts)
            .await
            .map_err(|error| error.app_error())?;
    }
    Ok(())
}

async fn stage(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    checkpoint: (&str, bool, i64),
    mut next: CollectedSnapshot,
    opts: &CallOptions,
) -> Result<(), AppError> {
    let (run, first, snapshot) = checkpoint;
    materialize(library, remote, binding, &mut next.notes, opts).await?;
    check(opts).map_err(|error| error.app_error())?;
    let binding = binding.clone();
    let run = run.to_owned();
    blocking(library, move |library| {
        library.sync_stage_page(
            &binding,
            &run,
            first,
            snapshot,
            next.page.next_key.as_deref(),
            &next.notes,
        )
    })
    .await
}

/// Pulls remote pages with durable snapshot checkpoints.
/// # Errors
/// Returns cancellation, stale binding, remote protocol, attachment or local transaction errors.
pub async fn pull(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    opts: &CallOptions,
) -> Result<(), AppError> {
    for restart in 0..ATTEMPTS {
        check(opts).map_err(|error| error.app_error())?;
        let state = blocking(library, |library| library.sync_current_binding())
            .await?
            .filter(|state| {
                state.binding.binding_id == binding.binding_id
                    && state.binding.binding_epoch == binding.binding_epoch
            })
            .ok_or_else(|| AppError::new(ErrorCode::Cancelled, "Sync binding superseded"))?;
        let (run, snapshot, mut after) = if restart == 0 {
            if let Some(run) = state.snapshot_run_id {
                (
                    run,
                    state.snapshot_cursor.ok_or_else(|| invalid().app_error())?,
                    state.after_key,
                )
            } else {
                let mut cursor = state.cursor;
                loop {
                    let mut next = ready_page(remote, cursor, None, None, opts)
                        .await
                        .map_err(|error| error.app_error())?;
                    if next.page.full {
                        let snapshot = next.page.cursor.get();
                        let after = next.page.next_key.clone();
                        let run = blocking(library, Library::sync_new_id).await?;
                        stage(library, remote, binding, (&run, true, snapshot), next, opts).await?;
                        break (run, snapshot, after);
                    }
                    cursor = next.page.cursor.get();
                    let more = next.page.has_more;
                    materialize(library, remote, binding, &mut next.notes, opts).await?;
                    check(opts).map_err(|error| error.app_error())?;
                    let binding = binding.clone();
                    blocking(library, move |library| {
                        library.sync_apply_page(
                            &binding,
                            cursor,
                            &next.notes,
                            &next.page.folders,
                            &next.page.tags,
                            &next.page.deletions,
                        )
                    })
                    .await?;
                    if !more {
                        return Ok(());
                    }
                }
            }
        } else {
            let next = ready_page(remote, 0, None, None, opts)
                .await
                .map_err(|error| error.app_error())?;
            if !next.page.full {
                return Err(invalid().app_error());
            }
            let snapshot = next.page.cursor.get();
            let after = next.page.next_key.clone();
            let run = blocking(library, Library::sync_new_id).await?;
            stage(library, remote, binding, (&run, true, snapshot), next, opts).await?;
            (run, snapshot, after)
        };
        while let Some(key) = after {
            let next = ready_page(remote, 0, Some(&key), Some(snapshot), opts)
                .await
                .map_err(|error| error.app_error())?;
            after = next.page.next_key.clone();
            stage(
                library,
                remote,
                binding,
                (&run, false, snapshot),
                next,
                opts,
            )
            .await?;
        }
        // Replay catch-up from the fixed snapshot on restart. Staging is
        // idempotent; the installed cursor remains untouched until commit.
        let mut cursor = snapshot;
        loop {
            let next = ready_page(remote, cursor, None, None, opts)
                .await
                .map_err(|error| error.app_error())?;
            if next.page.full && !(cursor == 0 && empty_zero(&next.page)) {
                break;
            }
            let more = next.page.has_more;
            cursor = next.page.cursor.get();
            stage(
                library,
                remote,
                binding,
                (&run, next.page.full, snapshot),
                next,
                opts,
            )
            .await?;
            if !more {
                check(opts).map_err(|error| error.app_error())?;
                let binding = binding.clone();
                return blocking(library, move |library| {
                    library.sync_commit_snapshot(&binding, &run, cursor)
                })
                .await;
            }
        }
    }
    Err(invalid().app_error())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_and_rejects_nonprogressing_pages() -> Result<(), serde_json::Error> {
        let value = serde_json::json!({"cursor":4,"full":false,"hasMore":false,"nextKey":null,"facetsFull":false,"settingsChanged":false,"notes":[],"folders":[],"tags":[],"deletions":[],"serverTime":0});
        let mut page: SyncResponse = serde_json::from_value(value)?;
        assert!(validate(&page, 4, None, None).is_ok());
        page.has_more = true;
        assert!(
            matches!(validate(&page, 4, None, None), Err(error) if error.code == ErrorCode::InvalidResponse)
        );
        page.full = true;
        page.facets_full = true;
        page.next_key = Some("repeated".into());
        assert!(validate(&page, 0, Some("repeated"), Some(4)).is_err());
        page.has_more = false;
        page.next_key = None;
        assert!(validate(&page, 0, Some("key"), Some(3)).is_err());
        Ok(())
    }
}
