use crate::window::DesktopState;
use aether_observability::{IngestBatch, IngestEntry, IngestLevel};
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
        log_available: app.state::<crate::AppContext>().logs.available(),
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
        let opener = if cfg!(target_os = "windows") {
            "explorer.exe"
        } else if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        let mut child = std::process::Command::new(opener)
            .arg(path)
            .spawn()
            .map_err(|_| AppError::new(ErrorCode::Internal, "Log folder could not be opened"))?;
        if !cfg!(windows)
            && !child
                .wait()
                .map_err(|_| AppError::new(ErrorCode::Internal, "Log folder could not be opened"))?
                .success()
        {
            return Err(AppError::new(
                ErrorCode::Internal,
                "Log folder could not be opened",
            ));
        }
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
    pub accepted: u32,
    pub rejected: u32,
}
#[tauri::command]
pub async fn app_log(
    context: tauri::State<'_, crate::AppContext>,
    entries: Value,
    dropped_count: u64,
) -> Result<LogReceipt, AppError> {
    if !serde_json::to_vec(&entries).is_ok_and(|bytes| bytes.len() <= 20 * 4096) {
        return Err(AppError::new(ErrorCode::BadRequest, "Log batch too large"));
    }
    let entries: Vec<LogRecord> = serde_json::from_value(entries)
        .map_err(|_| AppError::new(ErrorCode::BadRequest, "Invalid log batch"))?;
    if entries.len() > 20 {
        return Err(AppError::new(ErrorCode::BadRequest, "Log batch too large"));
    }
    let entries = entries
        .into_iter()
        .map(|entry| {
            if !autonote_shell::logging::valid_event(&entry.event)
                || !serde_json::to_vec(&entry.fields)
                    .is_ok_and(|bytes| bytes.len() + entry.event.len() + entry.level.len() <= 4000)
            {
                return Err(());
            }
            let level = match entry.level.as_str() {
                "debug" => IngestLevel::Debug,
                "info" => IngestLevel::Info,
                "warn" => IngestLevel::Warn,
                "error" => IngestLevel::Error,
                _ => return Err(()),
            };
            Ok(IngestEntry {
                level,
                event: entry.event,
                fields: Some(
                    entry
                        .fields
                        .into_iter()
                        .filter(|(key, value)| autonote_shell::logging::safe_field(key, value))
                        .map(|(key, value)| (key.to_ascii_lowercase(), value))
                        .collect(),
                ),
            })
        })
        .collect::<Result<Vec<_>, ()>>()
        .map_err(|_| AppError::new(ErrorCode::BadRequest, "Invalid log record"))?;
    let receipt = context.logs.ingest(&IngestBatch {
        entries,
        dropped_count,
    });
    Ok(LogReceipt {
        ok: true,
        available: context.logs.available(),
        accepted: receipt.accepted,
        rejected: receipt.rejected,
    })
}
