use crate::window::DesktopState;
use note_core::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    #[serde(flatten)]
    prefs: autonote_shell::desktop_prefs::DesktopPrefs,
    tray_available: bool,
    log_available: bool,
}
fn status(app: &tauri::AppHandle) -> Result<DesktopStatus, AppError> {
    let state = app.state::<DesktopState>();
    let prefs = state
        .prefs
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Internal, "Host settings unavailable"))?
        .clone();
    Ok(DesktopStatus {
        prefs,
        tray_available: state
            .tray_available
            .load(std::sync::atomic::Ordering::Relaxed),
        log_available: autonote_shell::logging::available(),
    })
}
#[tauri::command]
pub async fn desktop_prefs_get(app: tauri::AppHandle) -> Result<DesktopStatus, AppError> {
    status(&app)
}
#[tauri::command]
pub async fn desktop_prefs_save(
    app: tauri::AppHandle,
    prefs: Value,
) -> Result<DesktopStatus, AppError> {
    let prefs = note_core::parse_input(prefs)?;
    crate::shortcut::save(&app, prefs)?;
    status(&app)
}
#[tauri::command]
pub async fn desktop_close_ack(
    app: tauri::AppHandle,
    request_id: u64,
    pending: u64,
    failed: u64,
) -> Result<super::Ok<()>, AppError> {
    crate::window::acknowledge(&app, request_id, pending, failed)?;
    Ok(super::ok(()))
}
#[tauri::command]
pub async fn app_open_log_dir(
    context: tauri::State<'_, crate::AppContext>,
) -> Result<super::Ok<()>, AppError> {
    let path = context.data_dir.join("logs");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&path)
            .map_err(|_| AppError::new(ErrorCode::Internal, "Log folder unavailable"))?;
        #[cfg(target_os = "windows")]
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|_| AppError::new(ErrorCode::Internal, "Log folder could not be opened"))?;
        Ok(super::ok(()))
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::Internal, "Log folder could not be opened"))?
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogRecord {
    level: String,
    event: String,
    fields: std::collections::BTreeMap<String, Value>,
}
#[derive(Serialize)]
pub struct LogReceipt {
    pub ok: bool,
    pub available: bool,
}
#[tauri::command]
pub async fn app_log(entries: Value, dropped_count: u64) -> Result<LogReceipt, AppError> {
    if !serde_json::to_vec(&entries).is_ok_and(|bytes| bytes.len() <= 20 * 4096) {
        return Err(AppError::new(ErrorCode::BadRequest, "Log batch too large"));
    }
    let entries: Vec<LogRecord> = serde_json::from_value(entries)
        .map_err(|_| AppError::new(ErrorCode::BadRequest, "Invalid log batch"))?;
    if entries.len() > 20 {
        return Err(AppError::new(ErrorCode::BadRequest, "Log batch too large"));
    }
    for entry in &entries {
        if !matches!(entry.level.as_str(), "debug" | "info" | "warn" | "error")
            || !autonote_shell::logging::valid_event(&entry.event)
            || !serde_json::to_vec(&entry.fields)
                .is_ok_and(|bytes| bytes.len() + entry.event.len() + entry.level.len() <= 4000)
        {
            return Err(AppError::new(ErrorCode::BadRequest, "Invalid log record"));
        }
    }
    for entry in entries {
        let fields: std::collections::BTreeMap<_, _> = entry
            .fields
            .into_iter()
            .filter(|(key, value)| autonote_shell::logging::safe_field(key, value))
            .collect();
        let fields = serde_json::to_string(&fields)
            .map_err(|_| AppError::new(ErrorCode::BadRequest, "Invalid log fields"))?;
        match entry.level.as_str() {
            "debug" => {
                tracing::debug!(event = %entry.event, fields = %fields, "app.frontend.record")
            }
            "info" => tracing::info!(event = %entry.event, fields = %fields, "app.frontend.record"),
            "warn" => tracing::warn!(event = %entry.event, fields = %fields, "app.frontend.record"),
            "error" => {
                tracing::error!(event = %entry.event, fields = %fields, "app.frontend.record")
            }
            _ => return Err(AppError::new(ErrorCode::BadRequest, "Invalid log level")),
        }
    }
    if dropped_count > 0 {
        tracing::warn!(count = dropped_count, "app.log.dropped");
    }
    Ok(LogReceipt {
        ok: true,
        available: autonote_shell::logging::available(),
    })
}
