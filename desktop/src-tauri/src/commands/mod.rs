//! Tauri IPC commands (20 §6). Field names are camelCase like `@shared` types.
//!
//! Commands only forward: every argument that carries user data arrives as a
//! JSON value or string and is decoded by `note_core::parse_input`/`FromStr`
//! inside the blocking task, so a malformed body is the same `bad_request`
//! the kernel returns, never a transport-level decode error. Kernel failures
//! become `AppError` through `From<note_core::Error>`.

pub(crate) mod files;
pub(crate) mod library;
pub(crate) mod notes;

use std::sync::Arc;

use serde::Serialize;

use note_core::{AppError, ErrorCode, Library};

use crate::AppContext;

/// Runs `f` on the blocking pool; logs `ipc.command.failed` with the code only.
pub(crate) async fn run<T: Send + 'static>(
    command: &'static str,
    context: &AppContext,
    f: impl FnOnce(&Arc<Library>) -> Result<T, note_core::Error> + Send + 'static,
) -> Result<T, AppError> {
    let library = context.library.clone();
    let result = tauri::async_runtime::spawn_blocking(move || f(&library))
        .await
        .map_err(|_| AppError::new(ErrorCode::Internal, "Internal error"))
        .and_then(|r| r.map_err(AppError::from));
    if let Err(error) = &result {
        tracing::warn!(command, code = error.code().as_str(), "ipc.command.failed");
    }
    result
}

/// `{ ok: true }` plus extra fields, matching the worker envelopes.
#[derive(Serialize)]
pub struct Ok<T: Serialize> {
    ok: bool,
    #[serde(flatten)]
    rest: T,
}

pub(crate) fn ok<T: Serialize>(rest: T) -> Ok<T> {
    Ok { ok: true, rest }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    data_dir: String,
    schema_version: i64,
}

#[tauri::command]
pub async fn app_info(context: tauri::State<'_, AppContext>) -> Result<AppInfo, AppError> {
    let data_dir = context.data_dir.display().to_string();
    run("app_info", &context, move |library| {
        Ok(AppInfo {
            name: "AutoNote",
            version: env!("CARGO_PKG_VERSION"),
            data_dir,
            schema_version: library.schema_version()?,
        })
    })
    .await
}

/// Reads only the application's own log; the caller never supplies a path.
#[tauri::command]
pub async fn app_logs_tail(
    context: tauri::State<'_, AppContext>,
    limit: Option<usize>,
) -> Result<Vec<autonote_shell::logs::LogEntry>, AppError> {
    let path = autonote_shell::paths::log_file(&context.data_dir);
    run("app_logs_tail", &context, move |_| {
        Ok(autonote_shell::logs::tail(&path, limit.unwrap_or(300))?)
    })
    .await
}
