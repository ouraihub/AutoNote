//! Application shell: opens the library, registers commands, starts the window.
//!
//! No business logic lives here; commands forward to `note-core`.

mod commands;
mod events;
mod protocol;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use note_core::{AppError, Error, ErrorCode, Library, LibraryDeps, RandomIds, SystemClock};
use tauri::Manager;

/// Cancel flags for running Channel-reporting commands, keyed by caller jobId.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Jobs {
    /// Registers `job_id`; a duplicate id is `bad_request` so progress never mixes.
    ///
    /// # Errors
    /// `bad_request` for an empty, oversized or already-running id.
    pub fn start(&self, job_id: &str) -> Result<Arc<AtomicBool>, AppError> {
        if job_id.is_empty() || job_id.len() > 128 {
            return Err(AppError::new(
                ErrorCode::BadRequest,
                "jobId must be 1 to 128 characters",
            ));
        }
        let mut jobs = self.0.lock().map_err(|_| AppError::from(Error::Poisoned))?;
        if jobs.contains_key(job_id) {
            return Err(AppError::new(
                ErrorCode::BadRequest,
                "jobId is already running",
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        jobs.insert(job_id.to_owned(), flag.clone());
        Ok(flag)
    }
    pub fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.0.lock() {
            jobs.remove(job_id);
        }
    }
    /// `true` when a running job took the cancel; repeated cancels stay `true`.
    pub fn cancel(&self, job_id: &str) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).cloned())
            .is_some_and(|flag| {
                flag.store(true, Ordering::Relaxed);
                true
            })
    }
}

#[derive(Clone)]
pub struct AppContext {
    pub data_dir: PathBuf,
    pub library: Arc<Library>,
    pub jobs: Arc<Jobs>,
}

fn open_context(sink: Arc<events::TauriChangeSink>) -> Result<AppContext, Error> {
    let data_dir = autonote_shell::paths::data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    autonote_shell::logging::init(&autonote_shell::paths::log_file(&data_dir));
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "AutoNote starting");
    let library = Library::open_with_deps(
        &autonote_shell::paths::library_db(&data_dir),
        LibraryDeps {
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
            sink,
        },
    )?;
    Ok(AppContext {
        data_dir,
        library: Arc::new(library),
        jobs: Arc::default(),
    })
}

/// Starts the desktop application.
pub fn run() {
    let sink = Arc::new(events::TauriChangeSink::default());
    let context = match open_context(sink.clone()) {
        Ok(context) => context,
        Err(error) => {
            tracing::error!(
                code = AppError::from(error).code().as_str(),
                "library.open.failed"
            );
            eprintln!(
                "AutoNote cannot open its library. Move the application folder to a writable location."
            );
            return;
        }
    };

    if let Err(error) = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("autonote-file", |ctx, request, responder| {
            let library = ctx.app_handle().state::<AppContext>().library.clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::serve(&library, request));
            });
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let context = window.app_handle().state::<AppContext>();
                if let Err(error) = context.library.files_cancel_window(window.label()) {
                    tracing::warn!(reason = %AppError::from(error), "attachment.stage.failed");
                }
            }
        })
        .manage(context)
        .setup(move |app| {
            sink.bind(app.handle().clone());
            // The config window has `create: false`: built here so WebView2
            // never touches %LOCALAPPDATA% before data_directory is set.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("main window config missing")?;
            let data_dir = app.state::<AppContext>().data_dir.clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .data_directory(autonote_shell::paths::webview_dir(&data_dir))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_logs_tail,
            commands::library::session_load,
            commands::library::session_logout,
            commands::library::library_changes,
            commands::notes::notes_snapshot,
            commands::notes::notes_list,
            commands::notes::notes_get,
            commands::notes::notes_create,
            commands::notes::notes_patch,
            commands::notes::notes_remove,
            commands::notes::notes_restore,
            commands::notes::notes_purge,
            commands::notes::notes_duplicate,
            commands::notes::notes_empty_trash,
            commands::notes::notes_versions,
            commands::notes::notes_version,
            commands::notes::notes_restore_version,
            commands::notes::notes_backlinks,
            commands::notes::notes_flush,
            commands::library::folders_list,
            commands::library::folders_create,
            commands::library::folders_patch,
            commands::library::folders_remove,
            commands::library::tags_list,
            commands::library::tags_create,
            commands::library::tags_patch,
            commands::library::tags_remove,
            commands::library::search_query,
            commands::library::search_graph,
            commands::library::search_reindex,
            commands::library::jobs_cancel,
            commands::library::settings_get,
            commands::library::settings_save,
            commands::library::settings_stats,
            commands::files::files_upload_begin,
            commands::files::files_upload_chunk,
            commands::files::files_upload_finish,
            commands::files::files_upload_cancel,
            commands::files::files_list,
            commands::files::files_remove,
            commands::files::files_prune
        ])
        .run(tauri::generate_context!())
    {
        tracing::error!("app.start.failed");
        eprintln!("AutoNote failed to start: {error}");
    }
}
