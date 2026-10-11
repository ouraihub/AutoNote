//! Application shell: opens the library, registers commands, starts the window.
//!
//! No business logic lives here; commands forward to `note-core`.

mod commands;
mod events;
mod protocol;
mod shortcut;
mod tray;
mod window;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use aether_observability::LogConfig;
use aether_providers::{ModelRef, Store as ProviderStore};
use note_core::{AppError, Error, ErrorCode, Library, LibraryDeps, NoteId, RandomIds, SystemClock};
use tauri::Manager;

const NOTE_MAX_CHARS: usize = 24_000;
const NOTE_TITLE_MAX_CHARS: usize = 200;

struct AetherHost {
    library: Arc<OnceLock<Arc<Library>>>,
    providers: Arc<ProviderStore>,
}

struct LazyChatStore {
    root: PathBuf,
    store: Mutex<Option<Arc<aether_chat::SqliteStore>>>,
}

impl LazyChatStore {
    fn get(&self) -> Result<Arc<aether_chat::SqliteStore>, tauri_plugin_aether::KitError> {
        let mut store = self.store.lock().map_err(|_| {
            tauri_plugin_aether::KitError::internal(std::io::Error::other(
                "chat store lock poisoned",
            ))
        })?;
        if let Some(store) = &*store {
            return Ok(store.clone());
        }
        let opened = Arc::new(aether_chat::SqliteStore::open(&self.root)?);
        *store = Some(opened.clone());
        Ok(opened)
    }
}

impl tauri_plugin_aether::ConversationStore for LazyChatStore {
    fn list(
        &self,
        scope: Option<&str>,
        limit: usize,
    ) -> Result<Vec<aether_chat::ConversationSummary>, tauri_plugin_aether::KitError> {
        self.get()?.list(scope, limit)
    }
    fn load(&self, id: &str) -> Result<aether_chat::Conversation, tauri_plugin_aether::KitError> {
        self.get()?.load(id)
    }
    fn begin_turn(
        &self,
        conversation_id: Option<&str>,
        scope: Option<&str>,
        input: &str,
    ) -> Result<aether_chat::TurnHandle, tauri_plugin_aether::KitError> {
        self.get()?.begin_turn(conversation_id, scope, input)
    }
    fn regenerate(
        &self,
        conversation_id: &str,
    ) -> Result<aether_chat::TurnHandle, tauri_plugin_aether::KitError> {
        self.get()?.regenerate(conversation_id)
    }
    fn finish_turn(
        &self,
        turn: aether_chat::TurnHandle,
        record: aether_chat::TurnRecord,
    ) -> Result<(), tauri_plugin_aether::KitError> {
        self.get()?.finish_turn(turn, record)
    }
    fn delete(&self, id: &str) -> Result<(), tauri_plugin_aether::KitError> {
        self.get()?.delete(id)
    }
    fn rename(
        &self,
        id: &str,
        title: &str,
    ) -> Result<aether_chat::ConversationSummary, tauri_plugin_aether::KitError> {
        self.get()?.rename(id, title)
    }
}

impl tauri_plugin_aether::KitHost for AetherHost {
    fn select_model(
        &self,
        req: &tauri_plugin_aether::RunRequest,
    ) -> Result<ModelRef, tauri_plugin_aether::KitError> {
        if req.purpose != "chat" {
            return Err(tauri_plugin_aether::KitError::bad_request(
                "purpose",
                "unsupported",
            ));
        }
        let options = self
            .providers
            .model_options(aether_providers::ModelFilter {
                model_type: Some(aether_providers::ModelType::Chat),
                ..aether_providers::ModelFilter::default()
            })?;
        let valid = |model: &ModelRef| {
            options.iter().any(|option| {
                option.endpoint_id == model.endpoint_id && option.model_id == model.model_id
            })
        };
        if let Some(model) = &req.model
            && valid(model)
        {
            return Ok(model.clone());
        }
        let library = self.library.get().ok_or_else(|| {
            tauri_plugin_aether::KitError::internal(std::io::Error::other("library not ready"))
        })?;
        let settings = library.ai_role_settings().map_err(|error| {
            tauri_plugin_aether::KitError::internal(std::io::Error::other(error.to_string()))
        })?;
        settings
            .chat
            .map(|model| ModelRef {
                endpoint_id: model.endpoint_id,
                model_id: model.model_id,
            })
            .filter(valid)
            .ok_or_else(|| tauri_plugin_aether::KitError::needs_config("model"))
    }

    fn system_prompt(&self, req: &tauri_plugin_aether::RunRequest) -> Option<String> {
        Some(if req.language.starts_with("zh") {
            "你是 AutoNote 的笔记助手。请直接、准确地回答用户问题。".to_owned()
        } else {
            "You are AutoNote's note assistant. Answer directly and accurately.".to_owned()
        })
    }

    fn context(
        &self,
        req: &tauri_plugin_aether::RunRequest,
    ) -> Result<Option<tauri_plugin_aether::ContextBlock>, tauri_plugin_aether::KitError> {
        let Some(reference) = &req.context else {
            return Ok(None);
        };
        if reference.kind != "autonote-note" {
            return Err(tauri_plugin_aether::KitError::bad_request(
                "context.kind",
                "unsupported",
            ));
        }
        let id = NoteId::new(reference.id.clone())
            .map_err(|_| tauri_plugin_aether::KitError::not_found("note"))?;
        let library = self.library.get().ok_or_else(|| {
            tauri_plugin_aether::KitError::internal(std::io::Error::other("library not ready"))
        })?;
        let note = library
            .get_note(&id)
            .map_err(|_| tauri_plugin_aether::KitError::not_found("note"))?;
        let title: String = note
            .summary
            .title
            .trim()
            .chars()
            .take(NOTE_TITLE_MAX_CHARS)
            .collect();
        let content: String = note.content.chars().take(NOTE_MAX_CHARS).collect();
        Ok(Some(tauri_plugin_aether::ContextBlock {
            source: format!("AutoNote note {id}"),
            text: format!("笔记《{title}》\n\n{content}"),
        }))
    }
}

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
    pub sync: Arc<note_sync::SyncService>,
    pub mcp: Arc<note_mcp::McpServer>,
    pub logs: aether_observability::LogHandle,
    pub providers: Arc<ProviderStore>,
}

fn open_context(
    data_dir: PathBuf,
    sink: Arc<events::TauriChangeSink>,
    logs: aether_observability::LogHandle,
    providers: Arc<ProviderStore>,
) -> Result<AppContext, Error> {
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "AutoNote starting");
    let library = Library::open_with_deps(
        &autonote_shell::paths::library_db(&data_dir),
        LibraryDeps {
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
            sink: sink.clone(),
        },
    )?;
    let library = Arc::new(library);
    let sync = note_sync::SyncService::new(
        library.clone(),
        Arc::new(autonote_shell::credentials::DpapiSecretStore),
        sink.clone(),
    )
    .map_err(|_| Error::invalid("startup", "Sync service unavailable"))?;
    let mcp_settings: autonote_shell::desktop_prefs::McpHostSettings =
        autonote_shell::desktop_prefs::load(&autonote_shell::paths::mcp_settings_file(&data_dir))
            .unwrap_or_default();
    let mcp = Arc::new(note_mcp::McpServer::new(
        library.clone(),
        note_mcp::McpConfig {
            port: mcp_settings.port,
            ..note_mcp::McpConfig::default()
        },
    ));
    if mcp_settings.enabled {
        let server = mcp.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = server.start().await {
                tracing::warn!(code = ?error, "mcp.autostart.failed");
            }
        });
    }
    Ok(AppContext {
        data_dir,
        library,
        jobs: Arc::default(),
        sync,
        mcp,
        logs,
        providers,
    })
}

/// Starts the desktop application.
pub fn run() {
    let sink = Arc::new(events::TauriChangeSink::default());
    let data_dir = autonote_shell::paths::data_dir().unwrap_or_else(|error| {
        eprintln!("AutoNote could not start: {error}");
        std::process::exit(1);
    });
    if let Err(error) = autonote_shell::paths::prepare_data_dir(&data_dir) {
        eprintln!("AutoNote could not start: {error}");
        return;
    }
    let logs = match aether_observability::init(&data_dir.join("logs"), LogConfig::default(), None)
    {
        Ok(logs) => logs,
        Err(_) => {
            eprintln!("AutoNote could not start: Aether logging unavailable");
            return;
        }
    };
    let stores = ProviderStore::open(&data_dir).and_then(|store| {
        ProviderStore::open(&data_dir).map(|plugin_store| (Arc::new(store), plugin_store))
    });
    let (providers, plugin_store) = match stores {
        Ok(stores) => stores,
        Err(_) => {
            eprintln!("AutoNote could not start: provider store unavailable");
            return;
        }
    };
    let host_library = Arc::new(OnceLock::new());
    let chat_store: Arc<LazyChatStore> = Arc::new(LazyChatStore {
        root: data_dir.clone(),
        store: Mutex::new(None),
    });
    let host = Arc::new(AetherHost {
        library: host_library.clone(),
        providers: providers.clone(),
    });
    let aether = match tauri_plugin_aether::Builder::new(host, logs.clone())
        .providers(plugin_store)
        .chat(tauri_plugin_aether::ChatConfig::default(), Some(chat_store))
        .build()
    {
        Ok(plugin) => plugin,
        Err(_) => {
            eprintln!("AutoNote could not start: Aether unavailable");
            return;
        }
    };
    // Single-instance plugin must run before business services are opened.
    let application = tauri::Builder::default()
        .plugin(aether)
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            tray::show(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    let Some(state) = app.try_state::<window::DesktopState>() else {
                        return;
                    };
                    let enabled = state.prefs.try_lock().is_ok_and(|prefs| {
                        prefs.global_shortcut_enabled
                            && prefs
                                .global_shortcut
                                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                                .is_ok_and(|current| current == *shortcut)
                    });
                    if enabled {
                        tray::new_note(app);
                    }
                })
                .build(),
        )
        .manage(commands::transfer::TransferJobs::default())
        .register_asynchronous_uri_scheme_protocol("autonote-file", |ctx, request, responder| {
            let library = ctx.app_handle().state::<AppContext>().library.clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::serve(&library, request));
            });
        })
        .on_window_event(|window, event| {
            let state = window.app_handle().state::<window::DesktopState>();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. }
                    if !state.allow_exit.load(Ordering::Acquire) =>
                {
                    api.prevent_close();
                    window::request_close(window.app_handle(), false);
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    window::resized(window)
                }
                _ => {}
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .app_handle()
                    .state::<commands::transfer::TransferJobs>()
                    .cancel_window(window.label());
                let context = window.app_handle().state::<AppContext>();
                if let Err(error) = context.library.files_cancel_window(window.label()) {
                    tracing::warn!(reason = %AppError::from(error), "attachment.stage.failed");
                }
            }
        })
        .setup(move |app| {
            let context = open_context(
                data_dir.clone(),
                sink.clone(),
                logs.clone(),
                providers.clone(),
            )?;
            let _ = host_library.set(context.library.clone());
            let prefs = autonote_shell::desktop_prefs::load(
                &autonote_shell::paths::desktop_prefs_file(&context.data_dir),
            )?;
            let language = context.library.settings_get()?.appearance.language;
            app.manage(window::DesktopState::new(prefs, &language));
            app.manage(context.sync.clone());
            app.manage(context.mcp.clone());
            app.manage(context);
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
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .data_directory(autonote_shell::paths::webview_dir(&data_dir))
                .build()?;
            window::restore(&window, &data_dir);
            let tray_available = tray::install(app.handle()).is_ok();
            app.state::<window::DesktopState>()
                .tray_available
                .store(tray_available, Ordering::Relaxed);
            if let Ok(mut prefs) = app.state::<window::DesktopState>().prefs.lock() {
                if !tray_available {
                    prefs.close_to_tray = false;
                }
                if prefs.global_shortcut_enabled {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    if app
                        .global_shortcut()
                        .register(prefs.global_shortcut.as_str())
                        .is_err()
                    {
                        prefs.global_shortcut_enabled = false;
                        tracing::warn!(code = "conflict", "app.shortcut.registration_failed");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_logs_tail,
            commands::app::app_log,
            commands::app::app_open_log_dir,
            commands::app::desktop_prefs_get,
            commands::app::desktop_prefs_save,
            commands::app::desktop_close_ack,
            commands::ai::ai_providers_list,
            commands::ai::ai_provider_save,
            commands::ai::ai_provider_delete,
            commands::ai::ai_endpoint_key_reveal,
            commands::ai::ai_endpoint_probe,
            commands::ai::ai_roles_get,
            commands::ai::ai_roles_set,
            commands::ai::ai_write,
            commands::transfer::transfer_export,
            commands::transfer::transfer_import,
            commands::transfer::transfer_cancel,
            commands::mcp::mcp_status,
            commands::mcp::mcp_start,
            commands::mcp::mcp_stop,
            commands::mcp::mcp_set_port,
            commands::mcp::mcp_list_keys,
            commands::mcp::mcp_create_key,
            commands::mcp::mcp_revoke_key,
            commands::mcp::mcp_get_preferences,
            commands::mcp::mcp_save_preferences,
            commands::sync::sync_login,
            commands::sync::sync_complete_totp,
            commands::sync::sync_status,
            commands::sync::sync_bind_preview,
            commands::sync::sync_bind_confirm,
            commands::sync::sync_unbind,
            commands::sync::sync_start,
            commands::sync::sync_stop,
            commands::sync::sync_now,
            commands::sync::sync_resolve_conflict,
            commands::sync::sync_export_quarantined,
            commands::sync::sync_discard_quarantined,
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
        .build(tauri::generate_context!());
    match application {
        Ok(app) => app.run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && !handle
                    .state::<window::DesktopState>()
                    .allow_exit
                    .load(Ordering::Acquire)
            {
                api.prevent_exit();
                window::request_close(handle, true);
            }
        }),
        Err(error) => {
            tracing::error!(
                code = "internal",
                stage = "startup",
                "app.lifecycle.start_failed"
            );
            eprintln!(
                "AutoNote could not start. Move the application folder to a writable location. {error}"
            );
        }
    }
}
