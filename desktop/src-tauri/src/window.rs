use autonote_shell::{desktop_prefs::DesktopPrefs, window_state::WindowState};
use note_core::{AppError, ErrorCode};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub struct DesktopState {
    pub prefs: Mutex<DesktopPrefs>,
    pub tray_available: AtomicBool,
    pub allow_exit: AtomicBool,
    pub chinese: AtomicBool,
    shutting_down: AtomicBool,
    closing: AtomicBool,
    exit_requested: AtomicBool,
    request_id: AtomicU64,
    normal: Mutex<Option<WindowState>>,
    bounds_generation: AtomicU64,
}
impl DesktopState {
    pub fn new(prefs: DesktopPrefs, language: &str) -> Self {
        Self {
            prefs: Mutex::new(prefs),
            chinese: AtomicBool::new(language == "zh-CN"),
            shutting_down: AtomicBool::new(false),
            tray_available: AtomicBool::new(false),
            allow_exit: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            exit_requested: AtomicBool::new(false),
            request_id: AtomicU64::new(0),
            normal: Mutex::new(None),
            bounds_generation: AtomicU64::new(0),
        }
    }
}
pub fn request_close(app: &tauri::AppHandle, exit: bool) {
    let state = app.state::<DesktopState>();
    if exit {
        state.exit_requested.store(true, Ordering::Release);
    }
    if state.closing.swap(true, Ordering::AcqRel) {
        return;
    }
    let id = state.request_id.fetch_add(1, Ordering::AcqRel) + 1;
    if app
        .emit_to(
            "main",
            "autonote://prepare-close",
            serde_json::json!({"requestId":id}),
        )
        .is_err()
    {
        state.closing.store(false, Ordering::Release);
        state.exit_requested.store(false, Ordering::Release);
        crate::tray::show(app);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        let state = app.state::<DesktopState>();
        if state.request_id.load(Ordering::Acquire) != id
            || !state.closing.load(Ordering::Acquire)
            || state.shutting_down.load(Ordering::Acquire)
        {
            return;
        }
        ask_discard(&app, id, false);
    });
}
/// Lets the user keep editing or explicitly discard unconfirmed edits and quit; an OK-only notice here
/// would leave no way out when a save keeps failing.
fn ask_discard(app: &tauri::AppHandle, id: u64, failed: bool) {
    let state = app.state::<DesktopState>();
    crate::tray::show(app);
    let other = app.clone();
    let chinese = state.chinese.load(Ordering::Relaxed);
    let text = match (chinese, failed) {
        (true, true) => {
            "本地编辑未能保存（冲突或磁盘错误）。取消可继续编辑并重试，或丢弃未保存的编辑后退出。"
        }
        (false, true) => {
            "Local edits could not be saved (conflict or storage error). Cancel to keep editing and retry, or discard unsaved edits and quit."
        }
        (true, false) => {
            "AutoNote 无法确认本地编辑已保存。取消可继续编辑，或明确丢弃未确认编辑后退出。"
        }
        (false, false) => {
            "AutoNote cannot confirm that local edits are saved. Cancel to keep editing, or explicitly discard unconfirmed edits and quit."
        }
    };
    app.dialog()
        .message(text)
        .title("AutoNote")
        .buttons(MessageDialogButtons::OkCancelCustom(
            if chinese {
                "丢弃并退出"
            } else {
                "Discard and quit"
            }
            .into(),
            if chinese { "取消" } else { "Cancel" }.into(),
        ))
        .show(move |discard| {
            let state = other.state::<DesktopState>();
            if state.request_id.load(Ordering::Acquire) != id
                || state.shutting_down.load(Ordering::Acquire)
            {
                return;
            }
            if discard {
                finish_exit(&other);
            } else {
                state.closing.store(false, Ordering::Release);
                state.exit_requested.store(false, Ordering::Release);
                let _ = other.emit_to("main", "autonote://close-cancelled", ());
            }
        });
}
/// Completes the matching close handshake after local edits settle.
/// # Errors
/// Rejects stale confirmations and returns an internal error if hiding fails.
pub fn acknowledge(
    app: &tauri::AppHandle,
    id: u64,
    pending: u64,
    failed: u64,
) -> Result<(), AppError> {
    let state = app.state::<DesktopState>();
    if state.request_id.load(Ordering::Acquire) != id
        || !state.closing.load(Ordering::Acquire)
        || state.shutting_down.load(Ordering::Acquire)
    {
        return Err(AppError::new(
            ErrorCode::BadRequest,
            "Stale close confirmation",
        ));
    }
    if pending != 0 || failed != 0 {
        // Release the handshake first: the editor resumes (retry stays possible) and the 15 s timeout
        // cannot raise a second prompt. "Discard and quit" below still exits directly.
        state.closing.store(false, Ordering::Release);
        state.exit_requested.store(false, Ordering::Release);
        let _ = app.emit_to("main", "autonote://close-cancelled", ());
        ask_discard(app, id, true);
        return Ok(());
    }
    let hide = !state.exit_requested.load(Ordering::Acquire)
        && state.tray_available.load(Ordering::Acquire)
        && state.prefs.lock().is_ok_and(|p| p.close_to_tray);
    if hide {
        save_bounds(app);
        if let Some(window) = app.get_webview_window("main") {
            window
                .hide()
                .map_err(|_| AppError::new(ErrorCode::Internal, "Window could not be hidden"))?;
        }
        state.closing.store(false, Ordering::Release);
        state.exit_requested.store(false, Ordering::Release);
        let _ = app.emit_to("main", "autonote://close-cancelled", ());
    } else {
        finish_exit(app);
    }
    Ok(())
}
fn finish_exit(app: &tauri::AppHandle) {
    if app
        .state::<DesktopState>()
        .shutting_down
        .swap(true, Ordering::AcqRel)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let context = app.state::<crate::AppContext>();
        let shutdown =
            async {
                context.sync.shutdown().await?;
                context.mcp.shutdown().await.map_err(|_| {
                    AppError::new(ErrorCode::StorageUnavailable, "MCP shutdown failed")
                })?;
                app.state::<crate::commands::transfer::TransferJobs>()
                    .shutdown()
                    .await?;
                let library = context.library.clone();
                tauri::async_runtime::spawn_blocking(move || library.stop_writes())
                    .await
                    .map_err(|_| AppError::new(ErrorCode::Internal, "Shutdown worker failed"))?
                    .map_err(AppError::from)
            }
            .await;
        if let Err(error) = shutdown {
            let state = app.state::<DesktopState>();
            state.shutting_down.store(false, Ordering::Release);
            state.closing.store(false, Ordering::Release);
            state.exit_requested.store(false, Ordering::Release);
            let _ = app.emit_to("main", "autonote://close-cancelled", ());
            crate::tray::show(&app);
            tracing::error!(code = error.code().as_str(), "app.shutdown.failed");
            return;
        }
        save_bounds(&app);
        let _ = app.global_shortcut().unregister_all();
        if app.state::<crate::AppContext>().logs.flush().is_err() {
            // Do not emit through the logger being flushed; exit remains bounded.
            eprintln!("AutoNote log flush unavailable");
        }
        app.state::<DesktopState>()
            .allow_exit
            .store(true, Ordering::Release);
        app.exit(0);
    });
}
pub fn restore(window: &tauri::WebviewWindow, data_dir: &std::path::Path) {
    let path = autonote_shell::paths::window_state_file(data_dir);
    let saved = WindowState::load(&path);
    if let (Some(saved), Ok(monitors)) = (saved, window.available_monitors())
        && let Some(monitor) = monitors
            .iter()
            .find(|m| {
                let area = m.work_area();
                saved.x >= area.position.x
                    && saved.y >= area.position.y
                    && saved.x < area.position.x.saturating_add(area.size.width as i32)
                    && saved.y < area.position.y.saturating_add(area.size.height as i32)
            })
            .or_else(|| monitors.first())
    {
        let area = monitor.work_area();
        let clamped = saved.clamp(
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
            monitor.scale_factor(),
        );
        let _ = window.set_min_size(Some(tauri::PhysicalSize::new(
            960.min(area.size.width),
            640.min(area.size.height),
        )));
        let _ = window.set_size(tauri::PhysicalSize::new(clamped.width, clamped.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(clamped.x, clamped.y));
        if let Ok(mut normal) = window.app_handle().state::<DesktopState>().normal.lock() {
            *normal = Some(clamped);
        }
        if saved.maximized {
            let _ = window.maximize();
        }
    }
    capture_bounds(window);
}
fn capture_bounds(window: &tauri::WebviewWindow) {
    if window.is_minimized().unwrap_or(true)
        || window.is_maximized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
    {
        return;
    }
    if let (Ok(position), Ok(size), Ok(dpi)) = (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) && let Ok(mut normal) = window.app_handle().state::<DesktopState>().normal.lock()
    {
        *normal = Some(WindowState {
            version: 1,
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            dpi,
            maximized: false,
        });
    }
}
pub fn resized(window: &tauri::Window) {
    let Some(webview) = window.app_handle().get_webview_window("main") else {
        return;
    };
    capture_bounds(&webview);
    let generation = window
        .app_handle()
        .state::<DesktopState>()
        .bounds_generation
        .fetch_add(1, Ordering::AcqRel)
        + 1;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if app
            .state::<DesktopState>()
            .bounds_generation
            .load(Ordering::Acquire)
            == generation
        {
            save_bounds(&app);
        }
    });
}
fn save_bounds(app: &tauri::AppHandle) {
    let state = app.state::<DesktopState>();
    if let Ok(normal) = state.normal.lock()
        && let Some(mut bounds) = *normal
    {
        bounds.maximized = app
            .get_webview_window("main")
            .is_some_and(|w| w.is_maximized().unwrap_or(false));
        if bounds
            .save(&autonote_shell::paths::window_state_file(
                &app.state::<crate::AppContext>().data_dir,
            ))
            .is_err()
        {
            tracing::warn!(code = "internal", "app.window.persist_failed");
        }
    }
}
