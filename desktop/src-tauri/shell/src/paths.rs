//! Data directory layout.
//!
//! All runtime data lives in `<exe dir>\data`, never under `%APPDATA%`: the
//! system drive is the one most likely to be wiped on reinstall, and a copied
//! folder must carry its library with it. The install directory therefore has
//! to be writable.

use std::path::{Path, PathBuf};

/// Resolves the data root for the running executable.
///
/// Falls back to the working directory, then the temp directory, only when the
/// executable path cannot be determined.
#[must_use]
pub fn data_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(std::env::temp_dir)
        .join("data")
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
        assert_eq!(data_dir(), exe_dir.join("data"));
    }

    #[test]
    fn data_dir_is_not_under_app_data() {
        let dir = data_dir().to_string_lossy().to_ascii_lowercase();
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
