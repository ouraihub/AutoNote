use super::{CancellationToken, stage::Stage};
use crate::{Error, Millis};
use rusqlite::{OptionalExtension, params};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::io::{BufReader, Read};

#[path = "format_backup.rs"]
mod format_backup;
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
