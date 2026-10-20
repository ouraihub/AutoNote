//! Typed local settings, partitioned in the `prefs` table.
use crate::db::Library;
use crate::error::Error;
use crate::write::{WriteOrigin, Written};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Full settings DTO, matching shared `UserSettings`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserSettings {
    pub appearance: Appearance,
    pub editor: Editor,
    pub preview: Preview,
    pub backup: Backup,
    pub sync: Sync,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Appearance {
    pub language: String,
    pub theme: String,
    pub accent: String,
    pub background: String,
    pub density: String,
    pub prose_font: String,
    pub prose_size: f64,
    pub prose_width: String,
    pub prose_line_height: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Editor {
    pub font_size: f64,
    pub font_family: String,
    pub line_numbers: bool,
    pub typewriter: bool,
    pub focus_mode: bool,
    pub spellcheck: bool,
    pub show_toolbar: bool,
    pub tab_size: u32,
    pub auto_save_delay: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub layout: String,
    pub sync_scroll: bool,
    pub show_toc: bool,
    pub math: bool,
    pub mermaid: bool,
    pub code_block_collapse: bool,
    pub code_block_collapse_lines: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Backup {
    pub schedule: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sync {
    pub realtime: bool,
    pub poll_interval_ms: u32,
}

fn defaults() -> Value {
    json!({"appearance":{"language":"zh-CN","theme":"system","accent":"cinnabar","background":"paper","density":"comfortable","proseFont":"sans","proseSize":16,"proseWidth":"normal","proseLineHeight":1.65},"editor":{"fontSize":15,"fontFamily":"mono","lineNumbers":false,"typewriter":false,"focusMode":false,"spellcheck":false,"showToolbar":true,"tabSize":2,"autoSaveDelay":500},"preview":{"layout":"live","syncScroll":true,"showToc":true,"math":true,"mermaid":true,"codeBlockCollapse":true,"codeBlockCollapseLines":24},"backup":{"schedule":"sixHourly"},"sync":{"realtime":true,"pollIntervalMs":15000}})
}
fn load(conn: &rusqlite::Connection) -> Result<UserSettings, Error> {
    let mut base = defaults();
    for key in ["appearance", "editor", "preview", "backup", "sync"] {
        let stored: Option<String> = conn
            .query_row("SELECT value FROM prefs WHERE key=?1", [key], |r| r.get(0))
            .optional()?;
        if let Some(stored) = stored {
            let value: Value = serde_json::from_str(&stored)
                .map_err(|_| Error::invalid("settings", "invalid stored settings JSON"))?;
            let obj = value
                .as_object()
                .ok_or(Error::invalid("settings", "invalid stored settings schema"))?;
            let target = base
                .get_mut(key)
                .and_then(Value::as_object_mut)
                .ok_or(Error::invalid("settings", "invalid defaults"))?;
            for (name, value) in obj {
                if !target.contains_key(name) {
                    return Err(Error::invalid("settings", "unknown stored setting"));
                }
                target.insert(name.clone(), value.clone());
            }
        }
    }
    let settings: UserSettings = serde_json::from_value(base)
        .map_err(|_| Error::invalid("settings", "invalid stored settings schema"))?;
    validate(&settings)?;
    Ok(settings)
}
fn allowed(value: &str, values: &[&str]) -> bool {
    values.contains(&value)
}
fn validate(s: &UserSettings) -> Result<(), Error> {
    let a = &s.appearance;
    let e = &s.editor;
    let p = &s.preview;
    if !allowed(&a.language, &["zh-CN", "en-US"])
        || !allowed(&a.theme, &["light", "dark", "system"])
        || !allowed(
            &a.accent,
            &[
                "cinnabar",
                "indigo",
                "celadon",
                "amber",
                "terracotta",
                "wisteria",
                "graphite",
            ],
        )
        || !allowed(&a.background, &["paper", "white"])
        || !allowed(&a.density, &["comfortable", "compact"])
        || !allowed(&a.prose_font, &["sans", "serif"])
        || !allowed(&a.prose_width, &["narrow", "normal", "wide", "full"])
        || !allowed(&e.font_family, &["mono", "sans"])
        || !allowed(&p.layout, &["live", "split", "preview"])
        || !allowed(&s.backup.schedule, &["off", "hourly", "sixHourly", "daily"])
        || !(8.0..=36.0).contains(&a.prose_size)
        || !(1.0..=3.0).contains(&a.prose_line_height)
        || !(8.0..=36.0).contains(&e.font_size)
        || !(1..=8).contains(&e.tab_size)
        || !(100..=10_000).contains(&e.auto_save_delay)
        || !(1..=1000).contains(&p.code_block_collapse_lines)
        || !(1000..=300_000).contains(&s.sync.poll_interval_ms)
    {
        return Err(Error::invalid("settings", "invalid settings value"));
    }
    Ok(())
}
impl Library {
    /// Loads settings by partition, rejecting corrupt or unsupported persisted schemas.
    /// # Errors
    /// Returns an internal schema error for corrupt stored values, or SQLite failure.
    pub fn settings_get(&self) -> Result<UserSettings, Error> {
        self.read(|conn| {
            load(conn).map_err(|error| match error {
                Error::InvalidInput { .. } => Error::SchemaTooNew {
                    found: 3,
                    supported: 2,
                },
                other => other,
            })
        })
    }

    /// Applies a partial settings patch atomically and publishes one settings change.
    /// # Errors
    /// Rejects unknown fields and invalid values with bad_request.
    pub fn settings_save(
        &self,
        patch: &Value,
        origin: WriteOrigin,
    ) -> Result<Written<UserSettings>, Error> {
        let parts = patch
            .as_object()
            .ok_or(Error::invalid("settings", "expected object"))?;
        self.write(origin,|w|{
            let mut current=load(&w.tx)?;
            let mut base=serde_json::to_value(&current).map_err(|_|Error::invalid("settings","cannot encode settings"))?;
            for (key,value) in parts {let obj=value.as_object().ok_or(Error::invalid("settings","partition must be object"))?;let target=base.get_mut(key).and_then(Value::as_object_mut).ok_or(Error::invalid("settings","unknown partition"))?;for (field,v) in obj {if !target.contains_key(field){return Err(Error::invalid("settings","unknown field"));}target.insert(field.clone(),v.clone());}}
            current=serde_json::from_value(base).map_err(|_|Error::invalid("settings","invalid patch value"))?;validate(&current)?;
            for key in parts.keys(){let value=serde_json::to_value(&current).map_err(|_|Error::invalid("settings","encode failed"))?[key].to_string();w.tx.execute("INSERT INTO prefs(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![key,value,w.now.get()])?;}
            if !parts.is_empty(){w.changes.settings_changed=true;w.tx.execute("INSERT INTO changes(entity,entity_id,op,at) VALUES('settings','user','upsert',?1)",[w.now.get()])?;}
            Ok(current)
        })
    }

    /// Mirrors Web `GET /settings/stats`, same ten keys.
    /// # Errors
    /// Returns SQLite failures.
    pub fn settings_stats(&self) -> Result<std::collections::BTreeMap<&'static str, i64>, Error> {
        const KEYS: [&str; 10] = [
            "notes",
            "trashed",
            "folders",
            "tags",
            "attachments",
            "attachmentBytes",
            "chars",
            "words",
            "versions",
            "links",
        ];
        self.read(|conn| {
            let values = conn.query_row(
                "SELECT COUNT(CASE WHEN deleted_at IS NULL THEN 1 END), COUNT(deleted_at),
                   (SELECT COUNT(*) FROM folders WHERE deleted_at IS NULL), (SELECT COUNT(*) FROM tags),
                   (SELECT COUNT(*) FROM attachments), (SELECT COALESCE(SUM(size),0) FROM attachments),
                   COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN char_count ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN word_count ELSE 0 END),0),
                   (SELECT COUNT(*) FROM note_versions), (SELECT COUNT(*) FROM links)
                 FROM notes",
                [],
                |r| (0..10).map(|i| r.get::<_, i64>(i)).collect::<rusqlite::Result<Vec<_>>>(),
            )?;
            Ok(KEYS.into_iter().zip(values).collect())
        })
    }
}

/// Display name and avatar preference of the local library owner.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalProfile {
    pub name: String,
    pub avatar_url: String,
}

/// Partial update; absent fields keep their stored value.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalProfilePatch {
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

const PROFILE_NAME_MAX_CHARS: usize = 64;
const AVATAR_DATA_URL_MAX_BYTES: usize = 128 * 1024 * 4 / 3 + 64;

fn valid_avatar(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    if let Some(seed) = value.strip_prefix("dicebear:") {
        return (16..=64).contains(&seed.len())
            && seed
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    }
    if let Some(index) = value.strip_prefix("preset:") {
        return index.len() == 2 && matches!(index.parse::<u8>(), Ok(1..=12));
    }
    let image = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    ];
    value.len() <= AVATAR_DATA_URL_MAX_BYTES && image.iter().any(|prefix| value.starts_with(prefix))
}

impl Library {
    /// Loads the local profile; an unset profile is empty.
    /// # Errors
    /// Returns storage or malformed stored profile errors.
    pub fn local_profile(&self) -> Result<LocalProfile, Error> {
        self.read(|conn| {
            let value: Option<String> = conn
                .query_row("SELECT value FROM prefs WHERE key='profile'", [], |r| {
                    r.get(0)
                })
                .optional()?;
            value.map_or_else(
                || Ok(LocalProfile::default()),
                |value| {
                    serde_json::from_str(&value)
                        .map_err(|_| Error::invalid("profile", "invalid stored profile"))
                },
            )
        })
    }

    /// Applies a validated partial profile update and returns the stored profile.
    /// # Errors
    /// Rejects names outside 1..=64 characters after trimming and unsupported avatar values.
    pub fn local_profile_save(&self, patch: &LocalProfilePatch) -> Result<LocalProfile, Error> {
        let mut profile = self.local_profile()?;
        if let Some(name) = &patch.name {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > PROFILE_NAME_MAX_CHARS {
                return Err(Error::invalid("name", "must be 1-64 characters"));
            }
            name.clone_into(&mut profile.name);
        }
        if let Some(avatar) = &patch.avatar_url {
            if !valid_avatar(avatar) {
                return Err(Error::invalid("avatarUrl", "unsupported avatar"));
            }
            avatar.clone_into(&mut profile.avatar_url);
        }
        let value = serde_json::to_string(&profile)
            .map_err(|_| Error::invalid("profile", "cannot encode profile"))?;
        self.write(WriteOrigin::Ui, |w| {
            w.tx.execute(
                "INSERT INTO prefs(key,value,updated_at) VALUES('profile',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![value, w.now.get()],
            )?;
            Ok(())
        })?;
        Ok(profile)
    }
}

#[cfg(test)]
mod profile_tests {
    use super::valid_avatar;

    #[test]
    fn avatar_preferences_match_the_shared_rules() {
        for ok in [
            "",
            "preset:01",
            "preset:12",
            "dicebear:abcdefghijklmnop",
            "data:image/png;base64,AAAA",
        ] {
            assert!(valid_avatar(ok), "{ok}");
        }
        for bad in [
            "preset:00",
            "preset:13",
            "preset:1",
            "dicebear:short",
            "https://example.com/a.png",
            "data:image/svg+xml;base64,AAAA",
        ] {
            assert!(!valid_avatar(bad), "{bad}");
        }
    }
}
