use autonote_shell::desktop_prefs::DesktopPrefs;
use note_core::{AppError, ErrorCode};
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// Updates registrations and portable preferences, rolling back on persistence failure.
/// # Errors
/// Rejects unavailable tray/shortcuts, invalid key combinations, poisoned state,
/// registration failures and filesystem persistence or rollback failures.
pub fn save(app: &tauri::AppHandle, next: DesktopPrefs) -> Result<DesktopPrefs, AppError> {
    let state = app.state::<crate::window::DesktopState>();
    let mut prefs = state
        .prefs
        .lock()
        .map_err(|_| failure("Host settings unavailable"))?;
    if next.close_to_tray
        && !state
            .tray_available
            .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "System tray unavailable",
        ));
    }
    let path =
        autonote_shell::paths::desktop_prefs_file(&app.state::<crate::AppContext>().data_dir);
    transition(
        &prefs,
        &next,
        |key| {
            app.global_shortcut()
                .register(key)
                .map_err(|_| AppError::new(ErrorCode::Conflict, "Shortcut unavailable"))
        },
        |key| {
            app.global_shortcut()
                .unregister(key)
                .map_err(|_| failure("Shortcut could not be released"))
        },
        |value| {
            autonote_shell::desktop_prefs::save(&path, value)
                .map_err(|_| failure("Host settings could not be saved"))
        },
    )?;
    *prefs = next.clone();
    Ok(next)
}
fn failure(message: &'static str) -> AppError {
    AppError::new(ErrorCode::Internal, message)
}
fn parse(value: &str) -> Result<Shortcut, AppError> {
    if value.len() > 128 {
        return Err(AppError::new(ErrorCode::BadRequest, "Invalid shortcut"));
    }
    value
        .parse()
        .map_err(|_| AppError::new(ErrorCode::BadRequest, "Invalid shortcut"))
}
fn transition(
    old: &DesktopPrefs,
    next: &DesktopPrefs,
    mut register: impl FnMut(Shortcut) -> Result<(), AppError>,
    mut unregister: impl FnMut(Shortcut) -> Result<(), AppError>,
    mut persist: impl FnMut(&DesktopPrefs) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let old_key = parse(&old.global_shortcut)?;
    let next_key = parse(&next.global_shortcut)?;
    let added =
        next.global_shortcut_enabled && (!old.global_shortcut_enabled || next_key != old_key);
    let removed =
        old.global_shortcut_enabled && (!next.global_shortcut_enabled || next_key != old_key);
    if added {
        register(next_key)?;
    }
    // Disabling releases first, as requested; a failed save restores the registration.
    if removed && !next.global_shortcut_enabled {
        unregister(old_key)?;
    }
    if let Err(error) = persist(next) {
        if added {
            unregister(next_key).map_err(|_| failure("Shortcut rollback failed"))?;
        }
        if removed && !next.global_shortcut_enabled {
            register(old_key).map_err(|_| failure("Shortcut rollback failed"))?;
        }
        return Err(error);
    }
    if removed
        && next.global_shortcut_enabled
        && let Err(error) = unregister(old_key)
    {
        // Old registration still exists: remove the tentative key and restore the disk value.
        let released = unregister(next_key);
        let restored = persist(old);
        if released.is_err() || restored.is_err() {
            return Err(failure("Shortcut rollback failed"));
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "failed unwrap fails test")]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashSet;
    #[test]
    fn persistence_failure_preserves_old_registration_when_changing_or_disabling() {
        let old = DesktopPrefs::default();
        let old_key = parse(&old.global_shortcut).unwrap();
        for enabled in [true, false] {
            let keys = RefCell::new(HashSet::from([old_key]));
            let next = DesktopPrefs {
                global_shortcut_enabled: enabled,
                global_shortcut: "Ctrl+Alt+M".into(),
                ..old.clone()
            };
            let result = transition(
                &old,
                &next,
                |key| {
                    keys.borrow_mut().insert(key);
                    Ok(())
                },
                |key| {
                    keys.borrow_mut().remove(&key);
                    Ok(())
                },
                |_| Err(failure("disk full")),
            );
            assert!(result.is_err());
            assert_eq!(*keys.borrow(), HashSet::from([old_key]));
        }
    }
    #[test]
    fn occupied_shortcut_does_not_persist_and_alias_does_not_reregister() {
        let old = DesktopPrefs::default();
        let changed = DesktopPrefs {
            global_shortcut: "Ctrl+Alt+M".into(),
            ..old.clone()
        };
        let calls = RefCell::new(Vec::new());
        assert!(
            transition(
                &old,
                &changed,
                |_| Err(failure("occupied")),
                |_| {
                    calls.borrow_mut().push("release");
                    Ok(())
                },
                |_| {
                    calls.borrow_mut().push("persist");
                    Ok(())
                }
            )
            .is_err()
        );
        assert!(calls.borrow().is_empty());
        let alias = DesktopPrefs {
            global_shortcut: "Control+Alt+N".into(),
            ..old.clone()
        };
        transition(
            &old,
            &alias,
            |_| Err(failure("should not register")),
            |_| Err(failure("should not unregister")),
            |_| Ok(()),
        )
        .unwrap();
    }
    #[test]
    fn old_release_failure_restores_disk_and_removes_tentative_registration() {
        let old = DesktopPrefs::default();
        let old_key = parse(&old.global_shortcut).unwrap();
        let next = DesktopPrefs {
            global_shortcut: "Ctrl+Alt+M".into(),
            ..old.clone()
        };
        let keys = RefCell::new(HashSet::from([old_key]));
        let persisted = RefCell::new(old.global_shortcut.clone());
        assert!(
            transition(
                &old,
                &next,
                |key| {
                    keys.borrow_mut().insert(key);
                    Ok(())
                },
                |key| {
                    if key == old_key {
                        return Err(failure("release failed"));
                    }
                    keys.borrow_mut().remove(&key);
                    Ok(())
                },
                |value| {
                    *persisted.borrow_mut() = value.global_shortcut.clone();
                    Ok(())
                }
            )
            .is_err()
        );
        assert_eq!(*keys.borrow(), HashSet::from([old_key]));
        assert_eq!(*persisted.borrow(), old.global_shortcut);
    }
}
