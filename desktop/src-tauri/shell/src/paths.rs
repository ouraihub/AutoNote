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
}
