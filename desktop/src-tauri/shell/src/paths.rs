//! Data directory layout.
//!
//! All runtime data lives in `<exe dir>\data`, never under `%APPDATA%`: the
//! system drive is the one most likely to be wiped on reinstall, and a copied
//! folder must carry its library with it. The install directory therefore has
//! to be writable.

use std::path::{Path, PathBuf};

/// Resolves the data root for the running executable.
///
/// # Errors
/// When the executable path cannot be determined. There is deliberately no
/// fallback to cwd/TEMP/APPDATA: that would silently open an empty library.
pub fn data_dir() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "executable has no parent directory",
        )
    })?;
    Ok(dir.join("data"))
}

/// Creates and probes the executable-side runtime directories before opening a library.
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

/// WebView2 user data (cache, localStorage) inside `data_dir`; must be set
/// before the first WebView exists, or WebView2 picks `%LOCALAPPDATA%`.
#[must_use]
pub fn webview_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("webview")
}

/// Portable host-only configuration.
pub fn desktop_prefs_file(data_dir: &Path) -> PathBuf {
    data_dir.join("desktop-prefs.json")
}
/// Portable normal window bounds.
pub fn window_state_file(data_dir: &Path) -> PathBuf {
    data_dir.join("window-state.json")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
mod tests {
    use super::*;

    #[test]
    fn data_dir_sits_next_to_the_executable() {
        let exe_dir = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        assert_eq!(data_dir().unwrap(), exe_dir.join("data"));
    }

    #[test]
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
