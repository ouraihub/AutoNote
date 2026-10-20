//! Runtime data roots: portable beside the executable on Windows, user-owned on Unix.

use std::path::{Path, PathBuf};

/// Resolves the single platform-specific runtime data root.
///
/// # Errors
/// Returns an error instead of falling back to cwd or a temporary library.
pub fn data_dir() -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()?;
        let dir = exe
            .parent()
            .ok_or_else(|| invalid_directory("executable has no parent"))?;
        Ok(dir.join("data"))
    }
    #[cfg(not(windows))]
    user_data_dir(std::env::var_os("HOME"), std::env::var_os("XDG_DATA_HOME"))
}

fn invalid_directory(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}

#[cfg(not(windows))]
fn user_data_dir(
    home: Option<std::ffi::OsString>,
    xdg: Option<std::ffi::OsString>,
) -> std::io::Result<PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(xdg) = xdg.filter(|value| !value.is_empty()) {
        let root = PathBuf::from(xdg);
        if !root.is_absolute() {
            return Err(invalid_directory("XDG_DATA_HOME must be absolute"));
        }
        return Ok(root.join("com.autonote.desktop"));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = xdg;
    let home = PathBuf::from(home.ok_or_else(|| invalid_directory("HOME unavailable"))?);
    if !home.is_absolute() {
        return Err(invalid_directory("HOME must be absolute"));
    }
    #[cfg(target_os = "macos")]
    {
        Ok(home.join("Library/Application Support/com.autonote.desktop"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(home.join(".local/share/com.autonote.desktop"))
    }
}

/// Creates and probes required directories inside the resolved runtime data root.
/// Logs are excluded: unavailable logging must not prevent durable note saves.
///
/// # Errors
/// Returns the filesystem error when a required directory cannot be created or written.
pub fn prepare_data_dir(root: &Path) -> std::io::Result<()> {
    use std::io::Write;
    for directory in [
        root.to_path_buf(),
        root.join("files"),
        root.join("webview"),
        root.join("staging"),
    ] {
        std::fs::create_dir_all(&directory)?;
        let probe = directory.join(format!(".autonote-write-probe-{}", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        let result = file.write_all(b"writable").and_then(|()| file.sync_all());
        drop(file);
        let cleanup = std::fs::remove_file(probe);
        result?;
        cleanup?;
    }
    Ok(())
}

/// SQLite library file inside `data_dir`.
#[must_use]
pub fn library_db(data_dir: &Path) -> PathBuf {
    data_dir.join("library.db")
}

/// Log file inside `data_dir`.
#[must_use]
pub fn log_file(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("autonote.log")
}

/// Host-owned WebView data on Windows/Linux. Set before creating the first window.
#[must_use]
pub fn webview_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("webview")
}

/// Host-only configuration in the resolved runtime root.
pub fn desktop_prefs_file(data_dir: &Path) -> PathBuf {
    data_dir.join("desktop-prefs.json")
}
/// Normal window bounds in the resolved runtime root.
pub fn window_state_file(data_dir: &Path) -> PathBuf {
    data_dir.join("window-state.json")
}
/// Local MCP listener state in the resolved runtime root.
pub fn mcp_settings_file(data_dir: &Path) -> PathBuf {
    data_dir.join("mcp.json")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn data_dir_sits_next_to_the_executable() {
        let exe_dir = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        assert_eq!(data_dir().unwrap(), exe_dir.join("data"));
    }

    #[test]
    #[cfg(windows)]
    fn data_dir_is_not_under_app_data() {
        let dir = data_dir().unwrap().to_string_lossy().to_ascii_lowercase();
        for var in ["APPDATA", "LOCALAPPDATA"] {
            if let Ok(value) = std::env::var(var) {
                assert!(
                    !dir.starts_with(&value.to_ascii_lowercase()),
                    "data dir {dir} is under {var}"
                );
            }
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn user_root_rejects_missing_or_relative_home() {
        assert!(user_data_dir(None, None).is_err());
        assert!(user_data_dir(Some("relative".into()), None).is_err());
        let root = user_data_dir(Some("/home/test".into()), None).unwrap();
        #[cfg(target_os = "macos")]
        assert_eq!(
            root,
            PathBuf::from("/home/test/Library/Application Support/com.autonote.desktop")
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(
            root,
            PathBuf::from("/home/test/.local/share/com.autonote.desktop")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn xdg_root_takes_precedence_and_rejects_relative_paths() {
        assert_eq!(
            user_data_dir(None, Some("/custom".into())).unwrap(),
            PathBuf::from("/custom/com.autonote.desktop")
        );
        assert!(user_data_dir(Some("/home/test".into()), Some("relative".into())).is_err());
    }

    #[test]
    fn writability_gate_rejects_files_and_removes_probes() {
        let dir = tempfile::tempdir().unwrap();
        prepare_data_dir(dir.path()).unwrap();
        assert!(dir.path().join("webview").is_dir());
        assert!(
            !dir.path()
                .join(format!(".autonote-write-probe-{}", std::process::id()))
                .exists()
        );
        std::fs::write(dir.path().join("blocked"), b"occupied").unwrap();
        assert!(prepare_data_dir(&dir.path().join("blocked")).is_err());
    }
}
