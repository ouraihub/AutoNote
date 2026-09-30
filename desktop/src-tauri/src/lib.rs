//! Application shell: opens the library, registers commands, starts the window.
//!
//! No business logic lives here; commands forward to `note-core`.

mod commands;

use std::path::PathBuf;
use std::sync::Mutex;

use note_core::{AppError, Library};

pub struct AppContext {
    pub data_dir: PathBuf,
    pub library: Mutex<Library>,
}

fn open_context() -> Result<AppContext, AppError> {
    let data_dir = autonote_shell::paths::data_dir();
    std::fs::create_dir_all(&data_dir)?;
    autonote_shell::logging::init(&autonote_shell::paths::log_file(&data_dir));
    tracing::info!(version = env!("CARGO_PKG_VERSION"), dir = %data_dir.display(), "AutoNote starting");
    let library = Library::open(&autonote_shell::paths::library_db(&data_dir))?;
    Ok(AppContext {
        data_dir,
        library: Mutex::new(library),
    })
}

/// Starts the desktop application.
pub fn run() {
    let context = match open_context() {
        Ok(context) => context,
        Err(error) => {
            tracing::error!(%error, "failed to open library");
            eprintln!("AutoNote failed to open its library: {error}");
            return;
        }
    };

    if let Err(error) = tauri::Builder::default()
        .manage(context)
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .run(tauri::generate_context!())
    {
        tracing::error!(%error, "failed to start");
        eprintln!("AutoNote failed to start: {error}");
    }
}
