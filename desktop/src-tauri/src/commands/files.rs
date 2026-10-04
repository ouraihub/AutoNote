//! Attachment commands: only the originating WebView may use an upload session.
use note_core::{
    AppError, Attachment, AttachmentPage, ErrorCode, NoteId, PruneResult, UploadBegin,
};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

use super::{Ok, ok, run};
use crate::AppContext;

#[tauri::command]
pub async fn files_upload_begin(
    window: tauri::WebviewWindow,
    context: tauri::State<'_, AppContext>,
    filename: String,
    mime: String,
    size: u64,
    note_id: Option<NoteId>,
) -> Result<UploadBegin, AppError> {
    let owner = window.label().to_owned();
    run("files_upload_begin", &context, move |library| {
        library.files_upload_begin(&owner, &filename, &mime, size, note_id)
    })
    .await
}

#[derive(Serialize)]
pub struct Received {
    received: u64,
}

/// The JS caller passes raw Uint8Array as invoke body; uploadId and offset are
/// strict header values, never a JSON number array or caller-provided path.
#[tauri::command]
pub async fn files_upload_chunk(
    window: tauri::WebviewWindow,
    context: tauri::State<'_, AppContext>,
    request: Request<'_>,
) -> Result<Received, AppError> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned)
    };
    let upload_id = header("x-autonote-upload-id")
        .ok_or_else(|| AppError::new(ErrorCode::BadRequest, "Missing uploadId"))?;
    let offset = header("x-autonote-offset")
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| AppError::new(ErrorCode::BadRequest, "Invalid offset"))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new(
            ErrorCode::BadRequest,
            "Binary chunk required",
        ));
    };
    if bytes.len() > note_core::CHUNK_MAX_BYTES {
        return Err(AppError::new(
            ErrorCode::PayloadTooLarge,
            "Chunk exceeds limit",
        ));
    }
    let owner = window.label().to_owned();
    let bytes = bytes.clone();
    run("files_upload_chunk", &context, move |library| {
        let received = library.files_upload_chunk(&owner, &upload_id, offset, &bytes)?;
        Ok(Received { received })
    })
    .await
}

#[tauri::command]
pub async fn files_upload_finish(
    window: tauri::WebviewWindow,
    context: tauri::State<'_, AppContext>,
    upload_id: String,
) -> Result<Attachment, AppError> {
    let owner = window.label().to_owned();
    run("files_upload_finish", &context, move |library| {
        library.files_upload_finish(&owner, &upload_id)
    })
    .await
}

#[tauri::command]
pub async fn files_upload_cancel(
    window: tauri::WebviewWindow,
    context: tauri::State<'_, AppContext>,
    upload_id: String,
) -> Result<(), AppError> {
    let owner = window.label().to_owned();
    run("files_upload_cancel", &context, move |library| {
        library.files_upload_cancel(&owner, &upload_id)
    })
    .await
}

#[tauri::command]
pub async fn files_list(
    context: tauri::State<'_, AppContext>,
    cursor: Option<String>,
) -> Result<AttachmentPage, AppError> {
    run("files_list", &context, move |library| {
        library.files_list(cursor.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn files_remove(
    context: tauri::State<'_, AppContext>,
    id: String,
) -> Result<Ok<serde_json::Map<String, serde_json::Value>>, AppError> {
    run("files_remove", &context, move |library| {
        library.files_delete(&id.parse()?)?;
        Ok(ok(serde_json::Map::new()))
    })
    .await
}

#[tauri::command]
pub async fn files_prune(context: tauri::State<'_, AppContext>) -> Result<PruneResult, AppError> {
    run("files_prune", &context, |library| library.files_prune()).await
}
