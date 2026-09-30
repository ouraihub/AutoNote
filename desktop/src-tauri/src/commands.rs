//! Tauri IPC commands. Field names are camelCase to match `src/lib/ipc/types.ts`.

use serde::Serialize;

use note_core::AppError;

use crate::AppContext;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    data_dir: String,
    schema_version: i64,
}

#[tauri::command]
pub fn app_info(context: tauri::State<'_, AppContext>) -> Result<AppInfo, AppError> {
    let library = context
        .library
        .lock()
        .map_err(|_| AppError::new("LIBRARY_POISONED", "library lock poisoned"))?;
    Ok(AppInfo {
        name: "AutoNote",
        version: env!("CARGO_PKG_VERSION"),
        data_dir: context.data_dir.display().to_string(),
        schema_version: library.schema_version()?,
    })
}
