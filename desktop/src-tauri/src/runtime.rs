//! Desktop runtime composition and lifecycle.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use aether_observability::LogConfig;
use aether_providers::Store as ProviderStore;
use note_core::AppError;
use tauri::Manager;

use crate::{
    bootstrap::{AetherHost, LazyChatStore},
    commands, events, protocol, skill_runner,
    state::{AppContext, open_context},
    tray, window,
};

/// Starts the desktop application.
pub(crate) fn run() {
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
    let providers = match ProviderStore::open(&data_dir) {
        Ok(store) => Arc::new(store),
        Err(_) => {
            eprintln!("AutoNote could not start: provider store unavailable");
            return;
        }
    };
    let search = match aether_search::Store::open(
        &data_dir.join("search-config.db"),
        aether_runtime::AddressPolicy::default(),
    ) {
        Ok(store) => Arc::new(store),
        Err(_) => {
            eprintln!("AutoNote could not start: search store unavailable");
            return;
        }
    };
    let skills = match aether_skills::Store::open(&data_dir, aether_skills::creator::CREATOR_SKILLS)
    {
        Ok(store) => Arc::new(store),
        Err(_) => {
            eprintln!("AutoNote could not start: skills store unavailable");
            return;
        }
    };
    let mcp_client = match aether_mcp_client::Store::open(&data_dir) {
        Ok(store) => Arc::new(aether_mcp_client::McpRuntime::new(Arc::new(store))),
        Err(_) => {
            eprintln!("AutoNote could not start: MCP client store unavailable");
            return;
        }
    };
    let host_library = Arc::new(OnceLock::new());
    let chat_store: Arc<LazyChatStore> = Arc::new(LazyChatStore {
        root: data_dir.clone(),
        store: Mutex::new(None),
        writing: AtomicU64::new(0),
    });
    let host = Arc::new(AetherHost {
        library: host_library.clone(),
        providers: providers.clone(),
        chat_store: chat_store.clone(),
        skills: skill_runner::SkillRunner::new(skills.clone(), data_dir.clone()),
    });
    let settings: autonote_shell::desktop_prefs::McpHostSettings =
        autonote_shell::desktop_prefs::load(&autonote_shell::paths::mcp_settings_file(&data_dir))
            .unwrap_or_default();
    let aether_server = match aether_mcp_server::McpServer::new(
        &data_dir,
        aether_mcp_server::ServerConfig {
            default_port: settings.port,
            token_prefix: "autonote",
        },
        note_mcp::SCOPES.to_vec(),
        note_mcp::exposed_tools(host_library.clone()),
    ) {
        Ok(server) => server,
        Err(_) => {
            eprintln!("AutoNote could not start: MCP server unavailable");
            return;
        }
    };
    if note_mcp::enable_read_baseline(&aether_server).is_err() {
        eprintln!("AutoNote could not start: MCP server unavailable");
        return;
    }
    let conversations = Arc::new(aether_runtime::conversations::ConversationService::new(
        chat_store.clone(),
    ));
    let mut deps = aether_runtime::RunDependencies::new(providers.clone());
    deps.conversations = Some(chat_store);
    deps.skills = Some(skills.clone());
    deps.search = Some(search.clone());
    deps.mcp = Some(mcp_client.clone());
    let runs = match tauri::async_runtime::block_on(async {
        aether_runtime::RunService::new(
            host,
            aether_runtime::RunConfig::default(),
            deps,
            aether_runtime::AddressPolicy::default(),
        )
    }) {
        Ok(runs) => runs,
        Err(_) => {
            eprintln!("AutoNote could not start: Aether runtime unavailable");
            return;
        }
    };
    let skill_authoring = match tauri::async_runtime::block_on(async {
        aether_runtime::SkillAuthoringService::new(
            providers.clone(),
            skills.clone(),
            aether_runtime::AddressPolicy::default(),
        )
    }) {
        Ok(service) => service,
        Err(_) => {
            tauri::async_runtime::block_on(async {
                runs.shutdown(std::time::Duration::from_secs(3)).await;
                mcp_client.shutdown().await;
            });
            eprintln!("AutoNote could not start: skill authoring unavailable");
            return;
        }
    };
    let aether = match tauri_plugin_aether::Builder::new(logs.clone())
        .providers(providers.clone())
        .search(search)
        .runs(runs.clone())
        .conversations(conversations)
        .mcp_server(aether_server)
        .skills(skills)
        .skill_authoring(skill_authoring)
        .mcp_client(mcp_client.clone())
        .build()
    {
        Ok(plugin) => plugin,
        Err(_) => {
            tauri::async_runtime::block_on(async {
                runs.shutdown(std::time::Duration::from_secs(3)).await;
                mcp_client.shutdown().await;
            });
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
        .plugin(tauri_plugin_opener::init())
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
            // A stored binding resumes syncing on launch (22 §7.6).
            if matches!(context.library.sync_binding(), Ok(Some(_))) {
                let sync = context.sync.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = sync.start().await {
                        tracing::warn!(code = error.code().as_str(), "sync.autostart.failed");
                    }
                });
            }
            app.manage(context);
            // Restore the running state saved by mcp_start/mcp_stop; a taken port only logs.
            if settings.enabled {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let server = handle.state::<aether_mcp_server::McpServer>();
                    if let Err(error) = server.start().await {
                        tracing::warn!(code = ?error.code(), "mcp.autostart.failed");
                    }
                });
            }
            sink.bind(app.handle().clone());
            // Build the window after configuring the host-owned WebView data directory.
            // macOS WebKit uses its system-managed cache instead.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("main window config missing")?;
            let data_dir = app.state::<AppContext>().data_dir.clone();
            let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            #[cfg(not(target_os = "macos"))]
            let builder = builder.data_directory(autonote_shell::paths::webview_dir(&data_dir));
            let window = builder.build()?;
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
            commands::ai::ai_roles_get,
            commands::ai::ai_roles_set,
            commands::ai::ai_reply_export,
            commands::transfer::transfer_export,
            commands::transfer::transfer_import,
            commands::transfer::transfer_cancel,
            commands::mcp::mcp_status,
            commands::mcp::mcp_start,
            commands::mcp::mcp_stop,
            commands::mcp::mcp_set_port,
            commands::mcp::mcp_list_keys,
            commands::mcp::mcp_scopes,
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
            commands::library::session_load,
            commands::library::session_update_profile,
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
            tauri::async_runtime::block_on(async {
                runs.shutdown(std::time::Duration::from_secs(3)).await;
                mcp_client.shutdown().await;
            });
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
