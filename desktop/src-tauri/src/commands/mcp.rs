//! Local MCP control; domain secrets and listener lifetime stay in note-mcp.
use note_core::{AppError, ErrorCode};
use note_mcp::{AuthError, McpServer, Preferences, Scope, TokenRecord};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    running: bool,
    endpoint: Option<String>,
    port: u16,
    error: Option<&'static str>,
}
fn boundary(error: AuthError) -> AppError {
    let code = match error {
        AuthError::InvalidInput | AuthError::InsufficientEntropy => ErrorCode::BadRequest,
        AuthError::Unauthenticated => ErrorCode::Unauthenticated,
        AuthError::Forbidden => ErrorCode::Forbidden,
        AuthError::Listener => ErrorCode::StorageUnavailable,
    };
    AppError::new(code, "Local MCP operation failed")
}
async fn status(service: &McpServer) -> Result<LocalStatus, AppError> {
    let port = service.config().map_err(boundary)?.port;
    let running = service.is_running().await;
    Ok(LocalStatus {
        running,
        endpoint: running.then(|| format!("http://127.0.0.1:{port}/mcp")),
        port,
        error: None,
    })
}
async fn publish(app: &tauri::AppHandle, service: &McpServer) -> Result<LocalStatus, AppError> {
    let value = status(service).await?;
    if app.emit("autonote://mcp-status", &value).is_err() {
        tracing::warn!(code = "internal", "ipc.event.failed");
    }
    Ok(value)
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_status(
    service: tauri::State<'_, Arc<McpServer>>,
) -> Result<LocalStatus, AppError> {
    status(&service).await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_start(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<McpServer>>,
) -> Result<LocalStatus, AppError> {
    service.inner().start().await.map_err(boundary)?;
    publish(&app, &service).await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_stop(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<McpServer>>,
) -> Result<LocalStatus, AppError> {
    service.stop().await.map_err(boundary)?;
    publish(&app, &service).await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_set_port(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<McpServer>>,
    port: u16,
) -> Result<LocalStatus, AppError> {
    service.set_port(port).map_err(boundary)?;
    publish(&app, &service).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    id: String,
    name: String,
    scopes: Vec<&'static str>,
    created_at: u64,
    last_used_at: Option<u64>,
}
impl From<TokenRecord> for ApiKey {
    fn from(record: TokenRecord) -> Self {
        Self {
            id: record.id,
            name: record.name,
            scopes: record
                .scopes
                .into_iter()
                .map(|scope| scope.as_str())
                .collect(),
            created_at: record.created_at,
            last_used_at: record.last_used_at,
        }
    }
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_list_keys(
    service: tauri::State<'_, Arc<McpServer>>,
) -> Result<Vec<ApiKey>, AppError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .token_records()
            .map(|records| {
                records
                    .into_iter()
                    .filter(|record| record.revoked_at.is_none())
                    .map(ApiKey::from)
                    .collect()
            })
            .map_err(boundary)
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::Internal, "MCP key read failed"))?
}
#[derive(Serialize)]
pub struct CreatedKey {
    key: ApiKey,
    token: String,
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_create_key(
    service: tauri::State<'_, Arc<McpServer>>,
    name: String,
) -> Result<CreatedKey, AppError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut entropy = zeroize::Zeroizing::new([0_u8; 32]);
        getrandom::fill(&mut *entropy)
            .map_err(|_| AppError::new(ErrorCode::Internal, "Secure randomness unavailable"))?;
        let now = note_mcp::now_millis();
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| AppError::new(ErrorCode::Internal, "Secure randomness unavailable"))?;
        let id = note_core::id::encode_id(now, &random);
        let preferences = service.config().map_err(boundary)?.preferences;
        let mut scopes = vec![Scope::Read];
        if preferences.write_enabled {
            scopes.push(Scope::Write);
        }
        if preferences.trash_enabled {
            scopes.push(Scope::Trash);
        }
        let issued = service
            .issue_token(id, name, entropy.as_slice(), scopes, now)
            .map_err(boundary)?;
        Ok(CreatedKey {
            key: issued.record.into(),
            token: issued.token,
        })
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::Internal, "MCP key creation failed"))?
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_revoke_key(
    service: tauri::State<'_, Arc<McpServer>>,
    id: String,
) -> Result<super::Ok<()>, AppError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .revoke_token(&id, note_mcp::now_millis())
            .map_err(boundary)?;
        Ok(super::ok(()))
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::Internal, "MCP key revocation failed"))?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencePatch {
    write_enabled: Option<bool>,
    trash_enabled: Option<bool>,
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_get_preferences(
    context: tauri::State<'_, crate::AppContext>,
) -> Result<note_core::mcp::McpPreferences, AppError> {
    super::run("mcp_get_preferences", &context, |library| {
        library.mcp_preferences()
    })
    .await
}
#[tauri::command]
#[tracing::instrument(skip_all, err)]
pub async fn mcp_save_preferences(
    service: tauri::State<'_, Arc<McpServer>>,
    patch: serde_json::Value,
) -> Result<note_core::mcp::McpPreferences, AppError> {
    let patch: PreferencePatch = note_core::parse_input(patch).map_err(AppError::from)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let current = service.config().map_err(boundary)?.preferences;
        service
            .set_preferences(Preferences {
                write_enabled: patch.write_enabled.unwrap_or(current.write_enabled),
                trash_enabled: patch.trash_enabled.unwrap_or(current.trash_enabled),
            })
            .map_err(boundary)?;
        service.library().mcp_preferences().map_err(AppError::from)
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::Internal, "MCP preferences save failed"))?
}
