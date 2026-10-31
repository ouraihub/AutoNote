use std::sync::Arc;
use tauri::Manager;

use crate::{events, protocol, tray, window, AppContext};

pub fn build<P: tauri::plugin::Plugin<tauri::Wry>>(
    aether: P,
    data_dir: std::path::PathBuf,
    sink: Arc<events::TauriChangeSink>,
    logs: aether_observability::LogHandle,
    providers: Arc<aether_providers::Store>,
    host_library: Arc<std::sync::OnceLock<Arc<note_core::Library>>>,
    settings: autonote_shell::desktop_prefs::McpHostSettings,
    runs: Arc<aether_runtime::RunService>,
    mcp_client: Arc<aether_mcp_client::McpRuntime>,
) -> Result<tauri::App, tauri::Error> {
    tauri::Builder::default()
        .plugin(aether)
        .plugin(tauri_plugin_single_instance::init(|app, _, _| tray::show(app)))
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
        .manage(crate::commands::transfer::TransferJobs::default())
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
                    if !state.allow_exit.load(std::sync::atomic::Ordering::Acquire) =>
                {
                    api.prevent_close();
                    window::request_close(window.app_handle(), false);
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => window::resized(window),
                _ => {}
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .app_handle()
                    .state::<crate::commands::transfer::TransferJobs>()
                    .cancel_window(window.label());
                let context = window.app_handle().state::<AppContext>();
                if let Err(error) = context.library.files_cancel_window(window.label()) {
                    tracing::warn!(reason = %note_core::AppError::from(error), "attachment.stage.failed");
                }
            }
        })
        .setup(move |app| {
            let context = super::startup::open_context(
                data_dir.clone(), sink.clone(), logs.clone(), providers.clone(),
            )?;
            let _ = host_library.set(context.library.clone());
            let prefs = autonote_shell::desktop_prefs::load(
                &autonote_shell::paths::desktop_prefs_file(&context.data_dir),
            )?;
            let language = context.library.settings_get()?.appearance.language;
            app.manage(window::DesktopState::new(prefs, &language));
            app.manage(context.sync.clone());
            if matches!(context.library.sync_binding(), Ok(Some(_))) {
                let sync = context.sync.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = sync.start().await {
                        tracing::warn!(code = error.code().as_str(), "sync.autostart.failed");
                    }
                });
            }
            app.manage(context);
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
                .store(tray_available, std::sync::atomic::Ordering::Relaxed);
            if let Ok(mut prefs) = app.state::<window::DesktopState>().prefs.lock() {
                if !tray_available {
                    prefs.close_to_tray = false;
                }
                if prefs.global_shortcut_enabled {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    if app.global_shortcut().register(prefs.global_shortcut.as_str()).is_err() {
                        prefs.global_shortcut_enabled = false;
                        tracing::warn!(code = "conflict", "app.shortcut.registration_failed");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::app_info,
            crate::commands::app_logs_tail,
            crate::commands::app::app_log,
            crate::commands::app::app_open_log_dir,
            crate::commands::app::desktop_prefs_get,
            crate::commands::app::desktop_prefs_save,
            crate::commands::app::desktop_close_ack,
            crate::commands::ai::ai_roles_get,
            crate::commands::ai::ai_roles_set,
            crate::commands::ai::ai_reply_export,
            crate::commands::transfer::transfer_export,
            crate::commands::transfer::transfer_import,
            crate::commands::transfer::transfer_cancel,
            crate::commands::mcp::mcp_status,
            crate::commands::mcp::mcp_start,
            crate::commands::mcp::mcp_stop,
            crate::commands::mcp::mcp_set_port,
            crate::commands::mcp::mcp_list_keys,
            crate::commands::mcp::mcp_scopes,
            crate::commands::mcp::mcp_create_key,
            crate::commands::mcp::mcp_revoke_key,
            crate::commands::mcp::mcp_get_preferences,
            crate::commands::mcp::mcp_save_preferences,
            crate::commands::sync::sync_login,
            crate::commands::sync::sync_complete_totp,
            crate::commands::sync::sync_status,
            crate::commands::sync::sync_bind_preview,
            crate::commands::sync::sync_bind_confirm,
            crate::commands::sync::sync_unbind,
            crate::commands::sync::sync_start,
            crate::commands::sync::sync_stop,
            crate::commands::sync::sync_now,
            crate::commands::library::session_load,
            crate::commands::library::session_update_profile,
            crate::commands::library::session_logout,
            crate::commands::library::library_changes,
            crate::commands::notes::notes_snapshot,
            crate::commands::notes::notes_list,
            crate::commands::notes::notes_get,
            crate::commands::notes::notes_create,
            crate::commands::notes::notes_patch,
            crate::commands::notes::notes_remove,
            crate::commands::notes::notes_restore,
            crate::commands::notes::notes_purge,
            crate::commands::notes::notes_duplicate,
            crate::commands::notes::notes_empty_trash,
            crate::commands::notes::notes_versions,
            crate::commands::notes::notes_version,
            crate::commands::notes::notes_restore_version,
            crate::commands::notes::notes_backlinks,
            crate::commands::notes::notes_flush,
            crate::commands::library::folders_list,
            crate::commands::library::folders_create,
            crate::commands::library::folders_patch,
            crate::commands::library::folders_remove,
            crate::commands::library::tags_list,
            crate::commands::library::tags_create,
            crate::commands::library::tags_patch,
            crate::commands::library::tags_remove,
            crate::commands::library::search_query,
            crate::commands::library::search_graph,
            crate::commands::library::search_reindex,
            crate::commands::library::jobs_cancel,
            crate::commands::library::settings_get,
            crate::commands::library::settings_save,
            crate::commands::library::settings_stats,
            crate::commands::files::files_upload_begin,
            crate::commands::files::files_upload_chunk,
            crate::commands::files::files_upload_finish,
            crate::commands::files::files_upload_cancel,
            crate::commands::files::files_list,
            crate::commands::files::files_remove,
            crate::commands::files::files_prune
        ])
        .build(tauri::generate_context!())
}
