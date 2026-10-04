//! Folders, tags, search, settings, session and the host-internal change feed.
use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, json};

use note_core::{
    AppError, Cursor, Error, ErrorCode, Folder, FolderCreate, FolderDeleteStrategy, FolderPatch,
    GraphQuery, GraphResponse, ProgressEvent, ProgressPhase, SearchQuery, SearchResponse,
    SyncResponse, Tag, TagCreate, TagPatch, TagPatchResult, UserSettings, WriteOrigin, parse_input,
};
use tauri::ipc::Channel;

use super::{Ok, ok, run};
use crate::AppContext;

type Ctx<'a> = tauri::State<'a, AppContext>;

#[tauri::command]
pub async fn folders_list(context: Ctx<'_>) -> Result<Vec<Folder>, AppError> {
    run("folders_list", &context, |lib| lib.list_folders(false)).await
}

#[tauri::command]
pub async fn folders_create(context: Ctx<'_>, body: Value) -> Result<Folder, AppError> {
    run("folders_create", &context, move |lib| {
        Ok(lib
            .create_folder(&parse_input::<FolderCreate>(body)?, WriteOrigin::Ui)?
            .value)
    })
    .await
}

#[tauri::command]
pub async fn folders_patch(context: Ctx<'_>, id: String, body: Value) -> Result<Folder, AppError> {
    run("folders_patch", &context, move |lib| {
        let patch = parse_input::<FolderPatch>(body)?;
        Ok(lib
            .patch_folder(&id.parse()?, &patch, WriteOrigin::Ui)?
            .value)
    })
    .await
}

#[tauri::command]
pub async fn folders_remove(
    context: Ctx<'_>,
    id: String,
    strategy: String,
) -> Result<Ok<serde_json::Map<String, Value>>, AppError> {
    run("folders_remove", &context, move |lib| {
        let strategy = match strategy.as_str() {
            "move-up" => FolderDeleteStrategy::MoveUp,
            "delete" => FolderDeleteStrategy::Delete,
            _ => return Err(Error::invalid("strategy", "must be move-up or delete")),
        };
        lib.remove_folder(&id.parse()?, strategy, WriteOrigin::Ui)?;
        Ok(ok(serde_json::Map::new()))
    })
    .await
}

#[tauri::command]
pub async fn tags_list(context: Ctx<'_>) -> Result<Vec<Tag>, AppError> {
    run("tags_list", &context, |lib| lib.list_tags()).await
}

#[tauri::command]
pub async fn tags_create(context: Ctx<'_>, body: Value) -> Result<Tag, AppError> {
    run("tags_create", &context, move |lib| {
        Ok(lib
            .create_tag(&parse_input::<TagCreate>(body)?, WriteOrigin::Ui)?
            .value)
    })
    .await
}

#[tauri::command]
pub async fn tags_patch(
    context: Ctx<'_>,
    id: String,
    body: Value,
) -> Result<TagPatchResult, AppError> {
    run("tags_patch", &context, move |lib| {
        let patch = parse_input::<TagPatch>(body)?;
        Ok(lib.patch_tag(&id.parse()?, &patch, WriteOrigin::Ui)?.value)
    })
    .await
}

#[derive(Serialize)]
pub struct Affected {
    affected: u64,
}

#[tauri::command]
pub async fn tags_remove(context: Ctx<'_>, id: String) -> Result<Ok<Affected>, AppError> {
    run("tags_remove", &context, move |lib| {
        let affected = lib
            .remove_tag(&id.parse()?, WriteOrigin::Ui)?
            .value
            .affected;
        Ok(ok(Affected { affected }))
    })
    .await
}

#[tauri::command]
pub async fn search_query(context: Ctx<'_>, query: Value) -> Result<SearchResponse, AppError> {
    run("search_query", &context, move |lib| {
        lib.search_query(&parse_input::<SearchQuery>(query)?)
    })
    .await
}

#[tauri::command]
pub async fn search_graph(context: Ctx<'_>, query: Value) -> Result<GraphResponse, AppError> {
    run("search_graph", &context, move |lib| {
        lib.search_graph(&parse_input::<GraphQuery>(query)?)
    })
    .await
}

#[derive(Serialize)]
pub struct Indexed {
    indexed: u64,
}

/// Progress goes to the caller's Channel only; `jobs_cancel(jobId)` rolls the
/// rebuild back. Exactly one `terminal: true` item is sent, last.
#[tauri::command]
pub async fn search_reindex(
    context: Ctx<'_>,
    job_id: String,
    on_progress: Channel<ProgressEvent>,
) -> Result<Ok<Indexed>, AppError> {
    let cancel = context.jobs.start(&job_id)?;
    let jobs = context.jobs.clone();
    let (id, channel) = (job_id.clone(), on_progress.clone());
    let last = std::sync::Arc::new(std::sync::Mutex::new((0u64, None::<u64>)));
    let seen = last.clone();
    let result = run("search_reindex", &context, move |lib| {
        lib.search_reindex(&mut |completed, total| {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            if let Ok(mut last) = seen.lock() {
                *last = (completed, Some(total));
            }
            let _ = channel.send(progress(&id, completed, Some(total), false));
            Ok(())
        })
    })
    .await;
    jobs.finish(&job_id);
    let (completed, total) = match &result {
        Ok(indexed) => (*indexed, Some(*indexed)),
        Err(_) => last.lock().map_or((0, None), |l| *l),
    };
    let _ = on_progress.send(progress(&job_id, completed, total, true));
    Ok(ok(Indexed { indexed: result? }))
}

fn progress(job_id: &str, completed: u64, total: Option<u64>, terminal: bool) -> ProgressEvent {
    ProgressEvent {
        job_id: job_id.to_owned(),
        phase: ProgressPhase::Writing,
        completed,
        total,
        terminal,
    }
}

/// Returns whether a running job accepted the cancel.
#[tauri::command]
pub async fn jobs_cancel(context: Ctx<'_>, job_id: String) -> Result<bool, AppError> {
    Ok(context.jobs.cancel(&job_id))
}

#[tauri::command]
pub async fn settings_get(context: Ctx<'_>) -> Result<UserSettings, AppError> {
    run("settings_get", &context, |lib| lib.settings_get()).await
}

#[tauri::command]
pub async fn settings_save(context: Ctx<'_>, patch: Value) -> Result<UserSettings, AppError> {
    run("settings_save", &context, move |lib| {
        Ok(lib.settings_save(&patch, WriteOrigin::Ui)?.value)
    })
    .await
}

#[tauri::command]
pub async fn settings_stats(context: Ctx<'_>) -> Result<BTreeMap<&'static str, i64>, AppError> {
    run("settings_stats", &context, |lib| lib.settings_stats()).await
}

/// `BackendSession` for the local library: a stable owner so the shared UI is
/// `authed`; `site.attachmentStorage = 'local'` (21 §4, Q4).
#[tauri::command]
pub async fn session_load(context: Ctx<'_>) -> Result<Value, AppError> {
    run("session_load", &context, |lib| {
        let id = lib.library_id()?;
        Ok(json!({
            "user": {
                "id": id, "login": "local", "name": "Local", "avatarUrl": "",
                "role": "owner", "createdAt": 0, "username": "local",
            },
            "site": {
                "name": "AutoNote", "initialized": true, "registrationOpen": false,
                "r2Enabled": false, "kvEnabled": false, "attachmentStorage": "local",
                "realtimeEnabled": true, "version": env!("CARGO_PKG_VERSION"),
            },
            "settings": lib.settings_get()?,
        }))
    })
    .await
}

/// The local library has no account; logging out is refused, never faked.
#[tauri::command]
pub async fn session_logout() -> Result<(), AppError> {
    Err(AppError::new(
        ErrorCode::Forbidden,
        "The local library has no account to log out of",
    ))
}

/// Host-internal catch-up (not a Backend port). A stale or foreign cursor
/// returns the full snapshot (`full: true`).
#[tauri::command]
pub async fn library_changes(context: Ctx<'_>, since: Value) -> Result<SyncResponse, AppError> {
    run("library_changes", &context, move |lib| {
        let since = Cursor::new(
            since
                .as_i64()
                .ok_or(Error::invalid("since", "must be an integer"))?,
        )?;
        lib.library_changes(since)
    })
    .await
}
