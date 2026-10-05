use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

pub fn show(app: &tauri::AppHandle) {
    let result = (|| -> tauri::Result<()> {
        if let Some(window) = app.get_webview_window("main") {
            window.show()?;
            window.unminimize()?;
            window.set_focus()?;
        }
        Ok(())
    })();
    if result.is_err() {
        tracing::warn!(code = "internal", "app.window.show_failed");
    }
}
pub fn new_note(app: &tauri::AppHandle) {
    show(app);
    if app
        .emit_to("main", "autonote://ui-intent", "new-note")
        .is_err()
    {
        tracing::warn!(code = "internal", "app.intent.delivery_failed");
    }
}
fn labels(locale: &str) -> [&'static str; 4] {
    if locale == "zh-CN" {
        [
            "打开 AutoNote (&O)",
            "新建笔记 (&N)",
            "退出 (&Q)",
            "AutoNote — 打开笔记",
        ]
    } else {
        [
            "&Open AutoNote",
            "&New note",
            "&Quit",
            "AutoNote — Open notes",
        ]
    }
}
fn menu(app: &tauri::AppHandle, locale: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let [open, new, exit, _] = labels(locale);
    let open = MenuItem::with_id(app, "open", open, true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new", new, true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", exit, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &new, &exit])
}
/// Refreshes menu labels and tooltip for the active application language.
/// # Errors
/// Propagates menu creation, menu replacement and tooltip errors from Tauri.
pub fn refresh_locale(app: &tauri::AppHandle, locale: &str) -> tauri::Result<()> {
    app.state::<crate::window::DesktopState>()
        .chinese
        .store(locale == "zh-CN", std::sync::atomic::Ordering::Relaxed);
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu(app, locale)?))?;
        tray.set_tooltip(Some(labels(locale)[3]))?;
    }
    Ok(())
}
/// Installs the application's tray with the persisted language.
/// # Errors
/// Returns settings-read, menu-construction and tray-creation failures.
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let settings = app
        .state::<crate::AppContext>()
        .library
        .settings_get()
        .map_err(|_| tauri::Error::Io(std::io::Error::other("tray locale unavailable")))?;
    let locale = &settings.appearance.language;
    let menu = menu(app, locale)?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip(labels(locale)[3])
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show(app),
            "new" => new_note(app),
            "exit" => crate::window::request_close(app, true),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn both_tray_locales_have_keyboard_access_and_localized_tooltips() {
        for locale in ["zh-CN", "en-US"] {
            let labels = super::labels(locale);
            assert!(labels[..3].iter().all(|label| label.contains('&')));
        }
        assert_ne!(super::labels("zh-CN")[3], super::labels("en-US")[3]);
    }
}
