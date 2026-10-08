//! Portable host preferences, separate from domain settings and WebView prefs.
use serde::{Deserialize, Serialize};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Host-only settings persisted beside the executable.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopPrefs {
    pub close_to_tray: bool,
    pub global_shortcut_enabled: bool,
    pub global_shortcut: String,
}
impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            close_to_tray: false,
            global_shortcut_enabled: true,
            global_shortcut: "Ctrl+Alt+N".into(),
        }
    }
}
/// Local MCP listener state restored on launch; keys and guards live in the library.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpHostSettings {
    pub enabled: bool,
    pub port: u16,
}
impl Default for McpHostSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 7714,
        }
    }
}
/// Reads host settings; only a missing file selects defaults.
/// # Errors
/// Returns unreadable or malformed settings rather than silently replacing them.
pub fn load<T: serde::de::DeserializeOwned + Default>(path: &Path) -> io::Result<T> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error),
    }
}
/// Serializes and syncs a private same-directory file before replacing the old JSON.
/// # Errors
/// Returns serialization or filesystem failures; failed publication preserves the old file.
pub fn save<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("settings filename missing"))?;
    let (tmp, mut file) = loop {
        let mut tmp_name = name.to_os_string();
        tmp_name.push(format!(
            ".{}-{}.tmp",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let tmp = path.with_file_name(tmp_name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => break (tmp, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    let result = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| std::fs::rename(&tmp, path));
    if let Err(error) = result {
        if let Err(cleanup) = std::fs::remove_file(&tmp) {
            return Err(io::Error::new(
                error.kind(),
                format!("settings publication failed; temporary cleanup failed: {cleanup}"),
            ));
        }
        return Err(error);
    }
    Ok(())
}
#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "failed unwrap fails test")]
mod tests {
    use super::*;
    #[test]
    fn replacement_round_trips_and_never_removes_another_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop-prefs.json");
        let unrelated = path.with_extension("json.tmp");
        std::fs::write(&unrelated, b"other writer").unwrap();
        save(&path, &DesktopPrefs::default()).unwrap();
        save(
            &path,
            &DesktopPrefs {
                close_to_tray: true,
                ..DesktopPrefs::default()
            },
        )
        .unwrap();
        assert!(load::<DesktopPrefs>(&path).unwrap().close_to_tray);
        assert_eq!(std::fs::read(unrelated).unwrap(), b"other writer");
        assert!(save(dir.path(), &DesktopPrefs::default()).is_err());
        assert!(load::<DesktopPrefs>(&path).unwrap().close_to_tray);
    }
    #[test]
    fn mcp_settings_default_when_missing_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        assert_eq!(
            load::<McpHostSettings>(&path).unwrap(),
            McpHostSettings::default()
        );
        let running = McpHostSettings {
            enabled: true,
            port: 9100,
        };
        save(&path, &running).unwrap();
        assert_eq!(load::<McpHostSettings>(&path).unwrap(), running);
        std::fs::write(&path, br#"{"enabled":true}"#).unwrap();
        assert!(load::<McpHostSettings>(&path).is_err());
    }
}
