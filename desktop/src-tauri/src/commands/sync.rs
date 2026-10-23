//! Desktop synchronization commands; all persistence stays in SyncService/Library.
use note_core::AppError;
use note_sync::{BindPreview, CallOptions, LoginReply, SyncService, SyncStatus};
use std::sync::Arc;

#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_login(
    service: tauri::State<'_, Arc<SyncService>>,
    origin: String,
    username: String,
    password: String,
) -> Result<LoginReply, AppError> {
    let password = zeroize::Zeroizing::new(password);
    service
        .login(&origin, &username, &password, &CallOptions::default())
        .await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_complete_totp(
    service: tauri::State<'_, Arc<SyncService>>,
    login_id: String,
    challenge_token: String,
    code: String,
) -> Result<LoginReply, AppError> {
    service
        .complete_totp(&login_id, &challenge_token, &code, &CallOptions::default())
        .await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_status(
    service: tauri::State<'_, Arc<SyncService>>,
) -> Result<SyncStatus, AppError> {
    service.status().await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_bind_preview(
    service: tauri::State<'_, Arc<SyncService>>,
    login_id: String,
) -> Result<BindPreview, AppError> {
    service.preview(&login_id, &CallOptions::default()).await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_bind_confirm(
    service: tauri::State<'_, Arc<SyncService>>,
    preview_id: String,
) -> Result<SyncStatus, AppError> {
    service
        .inner()
        .confirm(&preview_id, &CallOptions::default())
        .await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_unbind(
    service: tauri::State<'_, Arc<SyncService>>,
) -> Result<SyncStatus, AppError> {
    service.unbind().await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_start(
    service: tauri::State<'_, Arc<SyncService>>,
) -> Result<SyncStatus, AppError> {
    service.inner().start().await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_stop(
    service: tauri::State<'_, Arc<SyncService>>,
) -> Result<SyncStatus, AppError> {
    service.stop().await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn sync_now(service: tauri::State<'_, Arc<SyncService>>) -> Result<SyncStatus, AppError> {
    service.now(&CallOptions::default()).await
}
