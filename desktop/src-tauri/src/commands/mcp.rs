use aether_mcp_server::{
    IssuedToken, KitError, KitErrorCode, McpServer, ScopeState, Status, TokenRecord,
};
use note_core::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    running: bool,
    endpoint: Option<String>,
    port: u16,
    error: Option<&'static str>,
}
/// Keeps the codes the UI branches on (`conflict` = port in use); Aether messages are safe text.
fn boundary(error: KitError) -> AppError {
    let code = match error.code() {
        KitErrorCode::BadRequest => ErrorCode::BadRequest,
        KitErrorCode::NotFound => ErrorCode::NotFound,
        KitErrorCode::Conflict => ErrorCode::Conflict,
        KitErrorCode::Forbidden => ErrorCode::Forbidden,
        KitErrorCode::Cancelled => ErrorCode::Cancelled,
        KitErrorCode::Timeout => ErrorCode::RequestTimeout,
        KitErrorCode::IncompatibleDb => ErrorCode::StorageUnavailable,
        KitErrorCode::Unsupported
        | KitErrorCode::Unauthorized
        | KitErrorCode::RateLimited
        | KitErrorCode::Upstream
        | KitErrorCode::Network
        | KitErrorCode::NeedsConfig
        | KitErrorCode::BudgetExceeded
        | KitErrorCode::Internal => ErrorCode::Internal,
    };
    AppError::new(code, error.message())
}
fn status(value: Status) -> LocalStatus {
    LocalStatus {
        running: value.running,
        endpoint: value.running.then_some(value.url),
        port: value.port,
        error: None,
    }
}
async fn publish(app: &tauri::AppHandle, server: &McpServer) -> Result<LocalStatus, AppError> {
    let value = status(server.status());
    if app.emit("autonote://mcp-status", &value).is_err() {
        tracing::warn!(code = "internal", "ipc.event.failed");
    }
    Ok(value)
}
async fn remember(app: &tauri::AppHandle, server: &McpServer) -> Result<LocalStatus, AppError> {
    let value = publish(app, server).await?;
    let path = autonote_shell::paths::mcp_settings_file(
        &tauri::Manager::state::<crate::AppContext>(app).data_dir,
    );
    let settings = autonote_shell::desktop_prefs::McpHostSettings {
        enabled: value.running,
        port: value.port,
    };
    if autonote_shell::desktop_prefs::save(&path, &settings).is_err() {
        tracing::warn!(code = "storage_unavailable", "mcp.settings.persist_failed");
    }
    Ok(value)
}
#[tauri::command]
pub async fn mcp_status(server: tauri::State<'_, McpServer>) -> Result<LocalStatus, AppError> {
    Ok(status(server.inner().status()))
}
#[tauri::command]
pub async fn mcp_start(
    app: tauri::AppHandle,
    server: tauri::State<'_, McpServer>,
) -> Result<LocalStatus, AppError> {
    server.start().await.map_err(boundary)?;
    remember(&app, server.inner()).await
}
#[tauri::command]
pub async fn mcp_stop(
    app: tauri::AppHandle,
    server: tauri::State<'_, McpServer>,
) -> Result<LocalStatus, AppError> {
    server.stop().await.map_err(boundary)?;
    remember(&app, server.inner()).await
}
#[tauri::command]
pub async fn mcp_set_port(
    app: tauri::AppHandle,
    server: tauri::State<'_, McpServer>,
    port: u16,
) -> Result<LocalStatus, AppError> {
    server.set_port(port).await.map_err(boundary)?;
    remember(&app, server.inner()).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    id: String,
    name: String,
    scopes: Vec<String>,
    created_at: i64,
    last_used_at: Option<i64>,
}
impl From<TokenRecord> for ApiKey {
    fn from(record: TokenRecord) -> Self {
        Self {
            id: record.id,
            name: record.name,
            scopes: record.scopes,
            created_at: record.created_at,
            last_used_at: record.last_used_at,
        }
    }
}
#[tauri::command]
pub async fn mcp_list_keys(server: tauri::State<'_, McpServer>) -> Result<Vec<ApiKey>, AppError> {
    server
        .tokens()
        .map(|v| {
            v.into_iter()
                .filter(|x| x.revoked_at.is_none())
                .map(ApiKey::from)
                .collect()
        })
        .map_err(boundary)
}
/// Wire shape `{ key, token }` (see `mcp_create_key` in `desktop/src/lib/ipc/validation.ts`).
#[derive(Serialize)]
pub struct CreatedKey {
    key: ApiKey,
    token: String,
}
/// Keys carry every declared scope; the write/trash switches (`enabled_scopes`) are the
/// single control, matching the settings UI which has no per-key scope picker.
#[tauri::command]
pub async fn mcp_create_key(
    server: tauri::State<'_, McpServer>,
    name: String,
) -> Result<CreatedKey, AppError> {
    let scopes: Vec<&str> = note_mcp::SCOPES.iter().map(|scope| scope.id).collect();
    server
        .issue_token(&name, &scopes)
        .map(|issued: IssuedToken| CreatedKey {
            key: issued.record.into(),
            token: issued.token,
        })
        .map_err(boundary)
}
#[tauri::command]
pub async fn mcp_revoke_key(
    server: tauri::State<'_, McpServer>,
    id: String,
) -> Result<super::Ok<()>, AppError> {
    server
        .revoke_token(&id)
        .map_err(boundary)
        .map(|_| super::ok(()))
}
#[tauri::command]
pub async fn mcp_scopes(server: tauri::State<'_, McpServer>) -> Result<Vec<ScopeState>, AppError> {
    server.scopes().map_err(boundary)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencePatch {
    write_enabled: Option<bool>,
    trash_enabled: Option<bool>,
}
#[tauri::command]
pub async fn mcp_save_preferences(
    server: tauri::State<'_, McpServer>,
    patch: serde_json::Value,
) -> Result<note_core::mcp::McpPreferences, AppError> {
    let patch: PreferencePatch = note_core::parse_input(patch).map_err(AppError::from)?;
    let current = server.scopes().map_err(boundary)?;
    let mut enabled: Vec<String> = current
        .iter()
        .filter(|s| s.enabled)
        .map(|s| s.id.clone())
        .collect();
    if patch.write_enabled == Some(false) {
        enabled.retain(|s| s != "notes:write");
    }
    if patch.write_enabled == Some(true) && !enabled.iter().any(|s| s == "notes:write") {
        enabled.push("notes:write".into());
    }
    if patch.trash_enabled == Some(false) {
        enabled.retain(|s| s != "notes:trash");
    }
    if patch.trash_enabled == Some(true) && !enabled.iter().any(|s| s == "notes:trash") {
        enabled.push("notes:trash".into());
    }
    let refs: Vec<&str> = enabled.iter().map(String::as_str).collect();
    server.set_enabled_scopes(&refs).map_err(boundary)?;
    preferences(&server)
}
#[tauri::command]
pub async fn mcp_get_preferences(
    server: tauri::State<'_, McpServer>,
) -> Result<note_core::mcp::McpPreferences, AppError> {
    preferences(&server)
}
fn preferences(server: &McpServer) -> Result<note_core::mcp::McpPreferences, AppError> {
    let scopes = server.scopes().map_err(boundary)?;
    Ok(note_core::mcp::McpPreferences {
        write_enabled: scopes.iter().any(|s| s.id == "notes:write" && s.enabled),
        trash_enabled: scopes.iter().any(|s| s.id == "notes:trash" && s.enabled),
        updated_at: 0,
    })
}
