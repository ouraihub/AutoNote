//! Attachment sessions and the filesystem/SQLite publication boundary.
#[path = "files_impl.rs"]
mod files_impl;
#[path = "files_prune.rs"]
mod files_prune;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::Library;
use crate::dto::{Attachment, AttachmentWithUsage};
use crate::error::{Entity, Error};
use crate::types::{AttachmentId, Millis, NoteId};

const MAX_BYTES: u64 = 25 * 1024 * 1024;
const QUOTA_BYTES: u64 = 1024 * 1024 * 1024;
/// Maximum raw IPC upload chunk, in bytes.
pub const CHUNK_MAX_BYTES: usize = 256 * 1024;
const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
/// Concurrent uploads across all windows; each holds an open stage file.
const MAX_SESSIONS: usize = 16;
const IDLE: Duration = Duration::from_secs(5 * 60);

/// Opaque short-lived upload handle and its binary chunk ceiling.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBegin {
    pub upload_id: String,
    pub chunk_max_bytes: usize,
}

struct Session {
    window: String,
    id: AttachmentId,
    note_id: Option<NoteId>,
    filename: String,
    mime: String,
    prefix: Vec<u8>,
    size: u64,
    offset: u64,
    path: PathBuf,
    file: File,
    hash: Sha256,
    touched: Instant,
    created_at: Millis,
}

/// The only managed state for in-flight upload handles.
pub(crate) struct FileStore {
    root: PathBuf,
    sessions: Mutex<HashMap<String, Session>>,
}

fn random_hex(conn: &rusqlite::Connection, length: i64) -> Result<String, Error> {
    let bytes: Vec<u8> = conn.query_row("SELECT randomblob(?1)", [length], |row| row.get(0))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 15) as usize] as char);
    }
    Ok(text)
}

fn safe_root(root: &Path) -> Result<(), Error> {
    fs::create_dir_all(root)?;
    if fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(Error::invalid("id", "unsafe files directory"));
    }
    Ok(())
}

/// Opens `root/<name>` only when neither the root nor the entry is a link or
/// reparse point, so a swapped junction cannot redirect reads outside `root`.
fn safe_file(path: &Path, root: &Path) -> Result<File, Error> {
    let unsafe_path = || Error::invalid("id", "unsafe attachment path");
    if fs::symlink_metadata(root)?.file_type().is_symlink()
        || !fs::symlink_metadata(path)?.file_type().is_file()
        || path.parent() != Some(root)
    {
        return Err(unsafe_path());
    }
    let file = File::open(path)?;
    if !file.metadata()?.is_file()
        || path.canonicalize()?
            != root
                .canonicalize()?
                .join(path.file_name().ok_or_else(unsafe_path)?)
    {
        return Err(unsafe_path());
    }
    Ok(file)
}

/// An object is in use if committed metadata, a live note or a version names it.
fn referenced(conn: &rusqlite::Connection, id: &str) -> Result<bool, Error> {
    let url = format!("/api/files/{id}");
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1)
            OR EXISTS(SELECT 1 FROM notes WHERE instr(content, ?2)>0)
            OR EXISTS(SELECT 1 FROM note_versions WHERE instr(content, ?2)>0)",
        params![id, url],
        |r| r.get(0),
    )?)
}

pub(crate) fn checked_mime(reported: &str, bytes: &[u8]) -> &'static str {
    match reported {
        "image/png" if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        "image/jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => "image/jpeg",
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => "image/gif",
        "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            "image/webp"
        }
        "image/avif"
            if bytes.get(4..8) == Some(b"ftyp")
                && bytes
                    .windows(4)
                    .take(16)
                    .any(|w| w == b"avif" || w == b"avis") =>
        {
            "image/avif"
        }
        "application/pdf" => "application/pdf",
        "text/plain" => "text/plain",
        "text/markdown" => "text/markdown",
        "application/json" => "application/json",
        "application/zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn attachment(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attachment> {
    let id: String = row.get(0)?;
    let note: Option<String> = row.get(1)?;
    let created: i64 = row.get(8)?;
    let size: i64 = row.get(4)?;
    Ok(Attachment {
        id: AttachmentId::new(id).map_err(|_| rusqlite::Error::InvalidQuery)?,
        note_id: note
            .map(NoteId::new)
            .transpose()
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        filename: row.get(2)?,
        mime: row.get(3)?,
        size: u64::try_from(size).map_err(|_| rusqlite::Error::InvalidQuery)?,
        width: row.get(5)?,
        height: row.get(6)?,
        url: format!("/api/files/{}", row.get::<_, String>(0)?),
        created_at: Millis::new(created).map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}

impl FileStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn transfer_root(&self) -> &Path {
        &self.root
    }

    // Export copies pinned objects into its own stage before releasing this
    // existing prune/upload lock; compression never holds the library lock.
    pub(crate) fn transfer_guard<T>(
        &self,
        f: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        let _guard = self.sessions.lock()?;
        f()
    }

    fn stage(&self) -> Result<PathBuf, Error> {
        safe_root(&self.root)?;
        let stage = self.root.join(".stage");
        safe_root(&stage)?;
        Ok(stage)
    }
}


impl FileStore {
    pub(crate) fn mcp_publish(
        &self,
        tx: &rusqlite::Transaction<'_>,
        identity: (&str, Option<&str>),
        filename: &str,
        mime: &str,
        bytes: &[u8],
        now: i64,
    ) -> Result<Attachment, Error> {
        let (id, note_id) = identity;
        if !crate::id::is_valid_id(id) {
            return Err(Error::invalid("attachment_id", "invalid attachment id"));
        }
        if filename.is_empty() || filename.len() > 720 || filename.chars().any(char::is_control) {
            return Err(Error::invalid("filename", "invalid filename"));
        }
        if bytes.len() > MAX_BYTES as usize {
            return Err(Error::TooLarge {
                field: "data",
                limit: MAX_BYTES,
            });
        }
        if let Some(note) = note_id {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1 AND deleted_at IS NULL)",
                [note],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(Error::NotFound {
                    entity: Entity::Note,
                    id: note.to_owned(),
                });
            }
        }
        let hash = format!("{:x}", Sha256::digest(bytes));
        let stage = self.stage()?;
        let part = stage.join(format!("{id}.mcp.part"));
        let dest = self.root.join(id);
        if dest.exists()
            || tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(Error::Duplicate {
                entity: Entity::Attachment,
            });
        }
        {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&part)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        if let Err(error) = fs::rename(&part, &dest) {
            let _ = fs::remove_file(&part);
            return Err(error.into());
        }
        let result = (|| {
            tx.execute("INSERT INTO attachments(id,note_id,filename,mime,size,sha256,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id,note_id,filename,mime,bytes.len() as i64,hash,now])?;
            Ok(Attachment {
                id: id
                    .parse()
                    .map_err(|_| Error::invalid("attachment_id", "invalid attachment id"))?,
                note_id: note_id
                    .map(|v| v.parse())
                    .transpose()
                    .map_err(|_| Error::invalid("note_id", "invalid note id"))?,
                filename: filename.to_owned(),
                mime: mime.to_owned(),
                size: bytes.len() as u64,
                width: None,
                height: None,
                url: format!("/api/files/{id}"),
                created_at: Millis::new(now)?,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&dest);
        }
        result
    }
}
#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
