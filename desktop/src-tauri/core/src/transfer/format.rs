use super::{CancellationToken, stage::Stage};
use crate::{Error, Millis};
use rusqlite::{OptionalExtension, params};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::io::{BufReader, Read};

// Mirrored from packages/shared/src/constants.ts; the fixture test checks these values.
pub(super) const UPLOAD_MAX: u64 = 64 * 1024 * 1024;
pub(super) const BUNDLE_MAX: u64 = 32 * 1024 * 1024;
pub(super) const EXPANDED_MAX: u64 = 80 * 1024 * 1024;
pub(super) const ENTRY_MAX: usize = 2500;
pub(super) const ITEM_MAX: u64 = UPLOAD_MAX;
pub(super) const CONTENT_MAX: usize = 2 * 1024 * 1024;
pub(super) const ATTACHMENT_MAX: u64 = 25 * 1024 * 1024;
pub(super) const BACKUP_FORMAT: &str = "autonote-markdown-backup";
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteEntry {
    pub id: String,
    pub path: String,
    pub title: String,
    pub folder: Vec<String>,
    pub attachment_hashes: Vec<String>,
    pub state: String,
    pub archived: bool,
    pub bytes: u64,
    pub sha256: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AttachmentEntry {
    pub path: String,
    pub filename: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: i64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlanNote {
    pub id: String,
    pub title: String,
    pub content: String,
    pub folder: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub is_archived: bool,
    pub is_starred: bool,
    pub is_pinned: bool,
}
pub(super) fn invalid() -> Error {
    Error::invalid("source", "invalid or incomplete backup")
}
pub(super) fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn timestamp(value: i64) -> Result<(), Error> {
    if value <= 0 {
        return Err(invalid());
    }
    Millis::new(value)?;
    Ok(())
}
pub(super) fn safe_path(value: &str) -> Result<(), Error> {
    if value.is_empty() || value.len() > 2048 || value.contains('\\') {
        return Err(invalid());
    }
    for part in value.split('/') {
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            return Err(invalid());
        }
        let base = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
            || (base.len() == 4
                && (base.starts_with("com") || base.starts_with("lpt"))
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub(super) fn folder_valid(folder: &[String]) -> Result<(), Error> {
    if folder.len() > 12
        || folder.iter().any(|n| {
            n.is_empty()
                || n.trim() != n
                || n.encode_utf16().count() > 100
                || n.contains(['/', '\\'])
                || n.chars().any(char::is_control)
        })
    {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn validate_plan(note: &PlanNote) -> Result<(), Error> {
    if !crate::id::is_valid_id(&note.id)
        || note.title.encode_utf16().count() > 512
        || note.content.len() > CONTENT_MAX
    {
        return Err(invalid());
    }
    folder_valid(&note.folder)?;
    timestamp(note.created_at)?;
    timestamp(note.updated_at)?;
    if let Some(at) = note.deleted_at {
        timestamp(at)?;
    }
    Ok(())
}
impl NoteEntry {
    fn validate(&self) -> Result<(), Error> {
        safe_path(&self.path)?;
        folder_valid(&self.folder)?;
        if !crate::id::is_valid_id(&self.id)
            || self.title.encode_utf16().count() > 512
            || !hash_valid(&self.sha256)
            || self.bytes > ITEM_MAX
        {
            return Err(invalid());
        }
        timestamp(self.created_at)?;
        timestamp(self.updated_at)?;
        match self.state.as_str() {
            "notes" if !self.archived && self.deleted_at.is_none() => (),
            "archived" if self.archived && self.deleted_at.is_none() => (),
            "trash" if self.deleted_at.is_some() => {
                timestamp(self.deleted_at.ok_or_else(invalid)?)?
            }
            _ => return Err(invalid()),
        }
        let mut hashes = std::collections::HashSet::new();
        if self
            .attachment_hashes
            .iter()
            .any(|h| !hash_valid(h) || !hashes.insert(h))
        {
            return Err(invalid());
        }
        Ok(())
    }
}
impl AttachmentEntry {
    pub fn validate(&self) -> Result<(), Error> {
        safe_path(&self.path)?;
        timestamp(self.created_at)?;
        if !hash_valid(&self.sha256)
            || !self
                .path
                .starts_with(&format!("attachments/{}--", self.sha256))
            || self.filename.is_empty()
            || self.filename.encode_utf16().count() > 180
            || self.mime.is_empty()
            || self.mime.len() > 255
            || self.size > ATTACHMENT_MAX
        {
            return Err(invalid());
        }
        Ok(())
    }
}
pub(super) fn validate_attachment_file(
    mut file: std::fs::File,
    entry: &AttachmentEntry,
) -> Result<(), Error> {
    let mut prefix = [0u8; 128];
    let count = file.read(&mut prefix)?;
    if entry.mime != "image/svg+xml"
        && crate::files::checked_mime(&entry.mime, &prefix[..count]) != entry.mime
    {
        return Err(invalid());
    }
    if entry.mime == "image/svg+xml"
        && !std::str::from_utf8(&prefix[..count]).is_ok_and(|text| {
            text.trim_start().starts_with("<svg") || text.trim_start().starts_with("<?xml")
        })
    {
        return Err(invalid());
    }
    if entry.mime == "application/pdf" && !prefix[..count].starts_with(b"%PDF-") {
        return Err(invalid());
    }
    Ok(())
}
struct ManifestSeed<'a> {
    stage: &'a Stage,
    cancel: &'a CancellationToken,
}
impl<'de> DeserializeSeed<'de> for ManifestSeed<'_> {
    type Value = (u32, String);
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for ManifestSeed<'_> {
    type Value = (u32, String);
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a backup manifest")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut format = None;
        let mut version = None;
        let mut snapshot = None;
        let mut notes = false;
        let mut attachments = false;
        let mut keys = std::collections::HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(serde::de::Error::custom("duplicate manifest field"));
            }
            self.cancel.check().map_err(serde::de::Error::custom)?;
            match key.as_str() {
                "format" => format = Some(map.next_value::<String>()?),
                "version" => version = Some(map.next_value::<u32>()?),
                "snapshot" => snapshot = Some(map.next_value::<String>()?),
                "appVersion" => {
                    let app = map.next_value::<String>()?;
                    if app.len() > 64 {
                        return Err(serde::de::Error::custom("app version"));
                    }
                }
                "createdAt" => {
                    let at = map.next_value::<String>()?;
                    time::OffsetDateTime::parse(
                        &at,
                        &time::format_description::well_known::Rfc3339,
                    )
                    .map_err(|_| serde::de::Error::custom("createdAt"))?;
                }
                "notes" => {
                    map.next_value_seed(EntrySeed {
                        stage: self.stage,
                        cancel: self.cancel,
                        notes: true,
                    })?;
                    notes = true;
                }
                "attachments" => {
                    map.next_value_seed(EntrySeed {
                        stage: self.stage,
                        cancel: self.cancel,
                        notes: false,
                    })?;
                    attachments = true;
                }
                _ => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        let version = version
            .filter(|v| matches!(v, 2 | 3))
            .ok_or_else(|| serde::de::Error::custom("version"))?;
        let stamp = snapshot.ok_or_else(|| serde::de::Error::custom("snapshot"))?;
        if format.as_deref() != Some(BACKUP_FORMAT)
            || !notes
            || !attachments
            || !keys.contains("appVersion")
            || !keys.contains("createdAt")
            || !stamp_valid(&stamp)
        {
            return Err(serde::de::Error::custom("manifest fields"));
        }
        Ok((version, stamp))
    }
}
struct EntrySeed<'a> {
    stage: &'a Stage,
    cancel: &'a CancellationToken,
    notes: bool,
}
impl<'de> DeserializeSeed<'de> for EntrySeed<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<(), D::Error> {
        de.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for EntrySeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("manifest records")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        if self.notes {
            while let Some(note) = seq.next_element::<NoteEntry>()? {
                self.cancel.check().map_err(serde::de::Error::custom)?;
                note.validate().map_err(serde::de::Error::custom)?;
                self.stage
                    .db
                    .execute(
                        "INSERT INTO notes VALUES(?1,?2)",
                        params![
                            note.id,
                            serde_json::to_string(&note).map_err(serde::de::Error::custom)?
                        ],
                    )
                    .map_err(|_| serde::de::Error::custom("duplicate note ID"))?;
            }
        } else {
            while let Some(attachment) = seq.next_element::<AttachmentEntry>()? {
                self.cancel.check().map_err(serde::de::Error::custom)?;
                attachment.validate().map_err(serde::de::Error::custom)?;
                self.stage
                    .db
                    .execute(
                        "INSERT INTO attachments VALUES(?1,?2)",
                        params![
                            attachment.sha256,
                            serde_json::to_string(&attachment).map_err(serde::de::Error::custom)?
                        ],
                    )
                    .map_err(|_| serde::de::Error::custom("duplicate attachment hash"))?;
            }
        }
        Ok(())
    }
}
fn stamp_valid(stamp: &str) -> bool {
    stamp.len() == 19
        && stamp.bytes().enumerate().all(|(i, b)| {
            if i == 8 || i == 15 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}
pub(super) fn read_text(mut reader: impl Read, max: u64) -> Result<String, Error> {
    let mut body = String::new();
    reader
        .by_ref()
        .take(max + 1)
        .read_to_string(&mut body)
        .map_err(|_| invalid())?;
    if body.len() as u64 > max {
        return Err(Error::TooLarge {
            field: "source",
            limit: max,
        });
    }
    Ok(body)
}
/// Returns a root prefix and selected manifest. Control files never downgrade to loose Markdown.
pub(super) fn select_backup(
    stage: &Stage,
    cancel: &CancellationToken,
) -> Result<Option<(String, String)>, Error> {
    let mut stmt = stage.db.prepare("SELECT path FROM entries WHERE lower(path) LIKE '%manifest.json' OR lower(path) LIKE '%complete' ORDER BY path")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut selected: Option<(String, String, String)> = None;
    let mut controls = false;
    let mut count = 0;
    stage
        .db
        .execute_batch("CREATE TABLE snapshot_stamps(stamp TEXT PRIMARY KEY);")?;
    for row in rows {
        let path = row?;
        let base = path.rsplit('/').next().unwrap_or_default();
        if base.eq_ignore_ascii_case("COMPLETE") {
            controls = true;
            if base != "COMPLETE" {
                return Err(invalid());
            }
            continue;
        }
        if !base.eq_ignore_ascii_case("manifest.json") {
            continue;
        }
        if base != "manifest.json" {
            return Err(invalid());
        }
        controls = true;
        let prefix = path.strip_suffix("manifest.json").ok_or_else(invalid)?;
        let complete_path = format!("{prefix}COMPLETE");
        let exists: bool = stage.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM entries WHERE path=?1)",
            [&complete_path],
            |r| r.get(0),
        )?;
        if !exists {
            continue;
        }
        let (file, _, hash) = stage.entry(&path)?;
        let complete = read_text(stage.entry(&complete_path)?.0, 256)?;
        let mut de = serde_json::Deserializer::from_reader(BufReader::new(file));
        // Stream records into the disk plan while validating each candidate; retain only the selected candidate afterward.
        stage
            .db
            .execute_batch("DELETE FROM notes; DELETE FROM attachments;")?;
        let parsed = ManifestSeed { stage, cancel }.deserialize(&mut de);
        cancel.check()?;
        let (version, stamp) = parsed.map_err(|_| invalid())?;
        de.end().map_err(|_| invalid())?;
        let marker = format!("{BACKUP_FORMAT} v{version}\nmanifest-sha256 {hash}\n");
        let normalized = complete.replace("\r\n", "\n");
        if normalized != marker && normalized != marker.trim_end_matches('\n') {
            return Err(invalid());
        }
        let root = if version == 2 {
            let suffix = format!("snapshots/{stamp}/");
            prefix.strip_suffix(&suffix).ok_or_else(invalid)?.to_owned()
        } else {
            prefix.to_owned()
        };
        if !root.is_empty() {
            safe_path(root.trim_end_matches('/'))?;
        }
        if selected
            .as_ref()
            .is_some_and(|(_, old_root, _)| old_root != &root)
        {
            return Err(Error::invalid("source", "ambiguous backup roots"));
        }
        stage
            .db
            .execute("INSERT INTO snapshot_stamps VALUES(?1)", [&stamp])
            .map_err(|_| Error::invalid("source", "ambiguous complete snapshots"))?;
        count += 1;
        match &selected {
            Some((old, _, _)) if old == &stamp => {
                return Err(Error::invalid("source", "ambiguous complete snapshots"));
            }
            Some((old, _, _)) if old > &stamp => (),
            _ => selected = Some((stamp, root, path)),
        }
    }
    if let Some((_, root, path)) = selected {
        stage
            .db
            .execute_batch("DELETE FROM notes; DELETE FROM attachments;")?;
        let (file, _, _) = stage.entry(&path)?;
        let mut de = serde_json::Deserializer::from_reader(BufReader::new(file));
        let parsed = ManifestSeed { stage, cancel }.deserialize(&mut de);
        cancel.check()?;
        let (version, stamp) = parsed.map_err(|_| invalid())?;
        de.end().map_err(|_| invalid())?;
        stage
            .db
            .execute_batch("CREATE TABLE declared_paths(path TEXT PRIMARY KEY COLLATE NOCASE);")?;
        let mut notes = stage.db.prepare("SELECT data FROM notes ORDER BY id")?;
        for raw in notes.query_map([], |r| r.get::<_, String>(0))? {
            cancel.check()?;
            let note: NoteEntry = serde_json::from_str(&raw?).map_err(|_| invalid())?;
            let expected = if version == 2 {
                format!("snapshots/{stamp}/{}/", note.state)
            } else {
                format!("{}/", note.state)
            };
            if !note.path.starts_with(&expected) {
                return Err(invalid());
            }
            stage
                .db
                .execute("INSERT INTO declared_paths VALUES(?1)", [&note.path])
                .map_err(|_| invalid())?;
            let (_, size, hash) = stage.entry(&format!("{root}{}", note.path))?;
            if size != note.bytes || hash != note.sha256 {
                return Err(invalid());
            }
            for hash in &note.attachment_hashes {
                let found: Option<String> = stage
                    .db
                    .query_row("SELECT hash FROM attachments WHERE hash=?1", [hash], |r| {
                        r.get(0)
                    })
                    .optional()?;
                if found.is_none() {
                    return Err(invalid());
                }
            }
        }
        let mut attachments = stage
            .db
            .prepare("SELECT data FROM attachments ORDER BY hash")?;
        for raw in attachments.query_map([], |r| r.get::<_, String>(0))? {
            cancel.check()?;
            let entry: AttachmentEntry = serde_json::from_str(&raw?).map_err(|_| invalid())?;
            stage
                .db
                .execute("INSERT INTO declared_paths VALUES(?1)", [&entry.path])
                .map_err(|_| invalid())?;
            let (_, size, hash) = stage.entry(&format!("{root}{}", entry.path))?;
            if size != entry.size || hash != entry.sha256 {
                return Err(invalid());
            }
            validate_attachment_file(stage.entry(&format!("{root}{}", entry.path))?.0, &entry)?;
        }
        if count > 1 {
            stage.db.execute("INSERT INTO warnings VALUES('Multiple complete snapshots: restored the latest complete snapshot')",[])?;
        }
        return Ok(Some((root, path)));
    }
    if controls {
        return Err(invalid());
    }
    Ok(None)
}
