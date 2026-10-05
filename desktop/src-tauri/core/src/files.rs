//! Attachment sessions and the filesystem/SQLite publication boundary.
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

impl Library {
    /// Creates an expiring upload bound to a specific window. No JS filesystem path is accepted.
    ///
    /// # Errors
    /// Rejects invalid metadata, quota, unavailable storage and SQLite failures.
    pub fn files_upload_begin(
        &self,
        window: &str,
        filename: &str,
        mime: &str,
        size: u64,
        note_id: Option<NoteId>,
    ) -> Result<UploadBegin, Error> {
        if window.is_empty() {
            return Err(Error::invalid("window", "must not be empty"));
        }
        if filename.is_empty() || filename.len() > 720 || filename.chars().any(|c| c.is_control()) {
            return Err(Error::invalid("filename", "invalid filename"));
        }
        if mime.len() > 127
            || !mime
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'+' | b'-' | b'.'))
            || (!mime.is_empty() && !mime.contains('/'))
        {
            return Err(Error::invalid("mime", "invalid MIME type"));
        }
        if size > MAX_BYTES {
            return Err(Error::TooLarge {
                field: "size",
                limit: MAX_BYTES,
            });
        }
        let stage = self.files.stage()?;
        let now = self.clock.now()?;
        // Lock order everywhere: sessions, then conn. Held to the insert so two
        // concurrent begins cannot both pass the quota with the same headroom.
        let mut sessions = self.files.sessions.lock()?;
        sessions.retain(|_, session| session.touched.elapsed() < IDLE);
        if sessions.len() >= MAX_SESSIONS {
            return Err(Error::invalid("uploadId", "too many uploads in progress"));
        }
        let reserved: u64 = sessions.values().map(|s| s.size).sum();
        let (id, handle, nonce) = {
            let conn = self.conn.lock()?;
            let used: i64 =
                conn.query_row("SELECT COALESCE(SUM(size),0) FROM attachments", [], |r| {
                    r.get(0)
                })?;
            if u64::try_from(used)
                .unwrap_or(u64::MAX)
                .saturating_add(reserved)
                .saturating_add(size)
                > QUOTA_BYTES
            {
                return Err(Error::TooLarge {
                    field: "size",
                    limit: QUOTA_BYTES,
                });
            }
            if let Some(note) = &note_id {
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1 AND deleted_at IS NULL)",
                    [note.as_str()],
                    |r| r.get(0),
                )?;
                if !exists {
                    return Err(Error::NotFound {
                        entity: Entity::Note,
                        id: note.to_string(),
                    });
                }
            }
            let mut id = None;
            for _ in 0..8 {
                let random: Vec<u8> = conn.query_row("SELECT randomblob(16)", [], |r| r.get(0))?;
                let bytes: [u8; 16] = random
                    .try_into()
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let candidate = AttachmentId::new(self.ids.new_id(now, &bytes))?;
                let stored: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1)",
                    [candidate.as_str()],
                    |r| r.get(0),
                )?;
                if !stored && !self.files.root.join(candidate.as_str()).exists() {
                    id = Some(candidate);
                    break;
                }
            }
            (
                id.ok_or(Error::Duplicate {
                    entity: Entity::Attachment,
                })?,
                random_hex(&conn, 32)?,
                random_hex(&conn, 16)?,
            )
        };
        let path = stage.join(format!("{id}.{nonce}.part"));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        // `sessions` is still held from the quota check above.
        sessions.insert(
            handle.clone(),
            Session {
                window: window.to_owned(),
                id,
                note_id,
                filename: filename.to_owned(),
                mime: mime.to_owned(),
                prefix: Vec::with_capacity(128),
                size,
                offset: 0,
                path,
                file,
                hash: Sha256::new(),
                touched: Instant::now(),
                created_at: now,
            },
        );
        Ok(UploadBegin {
            upload_id: handle,
            chunk_max_bytes: CHUNK_MAX_BYTES,
        })
    }

    /// Appends exactly one raw binary chunk at the expected offset.
    ///
    /// # Errors
    /// Rejects foreign/expired handles, non-contiguous offsets and oversized chunks.
    pub fn files_upload_chunk(
        &self,
        window: &str,
        upload_id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<u64, Error> {
        let mut sessions = self.files.sessions.lock()?;
        let session = sessions
            .get_mut(upload_id)
            .ok_or_else(|| Error::invalid("uploadId", "unknown upload"))?;
        if session.window != window || session.touched.elapsed() >= IDLE {
            return Err(Error::invalid("uploadId", "unknown upload"));
        }
        if offset != session.offset {
            return Err(Error::invalid("offset", "must be contiguous"));
        }
        if bytes.is_empty() || bytes.len() > CHUNK_MAX_BYTES {
            return Err(Error::invalid("chunk", "invalid chunk size"));
        }
        let next = offset
            .checked_add(bytes.len() as u64)
            .ok_or(Error::TooLarge {
                field: "size",
                limit: MAX_BYTES,
            })?;
        if next > session.size || next > MAX_BYTES {
            return Err(Error::TooLarge {
                field: "size",
                limit: MAX_BYTES,
            });
        }
        if let Err(error) = session.file.write_all(bytes) {
            // A partial write leaves bytes the hash/offset never saw; retrying at
            // the old offset would publish a file whose sha256 lies. Drop the
            // session (and its stage file) so the caller must start over.
            if let Some(dead) = sessions.remove(upload_id) {
                drop(dead.file);
                let _ = fs::remove_file(&dead.path);
            }
            return Err(error.into());
        }
        session.hash.update(bytes);
        if session.prefix.len() < 128 {
            let take = (128 - session.prefix.len()).min(bytes.len());
            session.prefix.extend_from_slice(&bytes[..take]);
        }
        session.offset = next;
        session.touched = Instant::now();
        Ok(next)
    }

    /// Syncs stage data, publishes a new object, then commits its metadata.
    ///
    /// # Errors
    /// On failure the unpublished object remains protected for startup recovery.
    pub fn files_upload_finish(&self, window: &str, upload_id: &str) -> Result<Attachment, Error> {
        self.files_finish(window, upload_id, None)
    }

    /// Publishes verified download metadata and its epoch-scoped mapping together.
    /// The digest proves local integrity, not authenticity of remote bytes.
    ///
    /// # Errors
    /// Rejects invalid IDs, unknown/foreign/incomplete uploads, digest mismatch,
    /// or inactive bindings. Filesystem and SQLite failures abort publication.
    pub fn files_sync_finish(
        &self,
        window: &str,
        upload_id: &str,
        binding: &crate::sync::Binding,
        remote_id: &str,
        sha256: &str,
    ) -> Result<Attachment, Error> {
        if !crate::id::is_valid_id(remote_id) {
            return Err(Error::invalid("remoteId", "must be a valid attachment id"));
        }
        self.files_finish(window, upload_id, Some((binding, remote_id, sha256)))
    }

    fn files_finish(
        &self,
        window: &str,
        upload_id: &str,
        mapping: Option<(&crate::sync::Binding, &str, &str)>,
    ) -> Result<Attachment, Error> {
        let mut sessions = self.files.sessions.lock()?;
        let session = sessions
            .get(upload_id)
            .ok_or_else(|| Error::invalid("uploadId", "unknown upload"))?;
        if session.window != window || session.touched.elapsed() >= IDLE {
            return Err(Error::invalid("uploadId", "unknown upload"));
        }
        if session.offset != session.size {
            return Err(Error::invalid("size", "upload incomplete"));
        }
        let session = sessions
            .remove(upload_id)
            .ok_or_else(|| Error::invalid("uploadId", "unknown upload"))?;
        session.file.sync_all()?;
        drop(session.file);
        let hash = format!("{:x}", session.hash.finalize());
        if mapping.is_some_and(|(_, _, expected)| expected != hash) {
            return Err(Error::invalid("sha256", "download digest mismatch"));
        }
        let dest = self.files.root.join(session.id.as_str());
        if dest.exists() {
            return Err(Error::Duplicate {
                entity: Entity::Attachment,
            });
        }
        fs::rename(&session.path, &dest)?;
        // Keep session lock until COMMIT: prune cannot reclaim the published object.
        let result = (|| {
            let mut conn = self.conn.lock()?;
            let tx = conn.transaction()?;
            if let Some((binding, _, _)) = mapping {
                crate::sync::require_binding(&tx, binding)?;
            }
            let used: i64 =
                tx.query_row("SELECT COALESCE(SUM(size),0) FROM attachments", [], |r| {
                    r.get(0)
                })?;
            if u64::try_from(used)
                .unwrap_or(u64::MAX)
                .saturating_add(session.size)
                > QUOTA_BYTES
            {
                return Err(Error::TooLarge {
                    field: "size",
                    limit: QUOTA_BYTES,
                });
            }
            if let Some(note) = &session.note_id {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1 AND deleted_at IS NULL)",
                    [note.as_str()],
                    |r| r.get(0),
                )?;
                if !exists {
                    return Err(Error::NotFound {
                        entity: Entity::Note,
                        id: note.to_string(),
                    });
                }
            }
            let mime = checked_mime(&session.mime, &session.prefix);
            tx.execute("INSERT INTO attachments (id,note_id,filename,mime,size,sha256,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![session.id.as_str(), session.note_id.as_ref().map(NoteId::as_str), session.filename, mime, session.size as i64, hash, session.created_at.get()])?;
            if let Some((binding, remote_id, _)) = mapping {
                tx.execute("INSERT INTO sync_attachment_map(binding_id,binding_epoch,local_attachment_id,remote_attachment_id,sha256,size,state) VALUES(?1,?2,?3,?4,?5,?6,'ready')",
                    params![binding.binding_id, binding.binding_epoch, session.id.as_str(), remote_id, hash, session.size as i64])?;
            }
            tx.commit()?;
            Ok(Attachment {
                id: session.id.clone(),
                note_id: session.note_id.clone(),
                filename: session.filename,
                mime: mime.to_owned(),
                size: session.size,
                width: None,
                height: None,
                url: format!("/api/files/{}", session.id),
                created_at: session.created_at,
            })
        })();
        drop(sessions);
        result
    }

    /// Cancels an in-flight upload, never an already committed attachment.
    ///
    /// # Errors
    /// Rejects handles belonging to another window.
    pub fn files_upload_cancel(&self, window: &str, upload_id: &str) -> Result<(), Error> {
        let mut sessions = self.files.sessions.lock()?;
        if let Some(session) = sessions.get(upload_id)
            && session.window != window
        {
            return Err(Error::invalid("uploadId", "unknown upload"));
        }
        sessions.remove(upload_id);
        Ok(())
    }

    /// Discards all in-flight uploads owned by a closed window.
    ///
    /// # Errors
    /// Returns an error if the sessions lock is poisoned.
    pub fn files_cancel_window(&self, window: &str) -> Result<(), Error> {
        self.files
            .sessions
            .lock()?
            .retain(|_, session| session.window != window);
        Ok(())
    }

    /// Expires inactive handles and performs reference-checked orphan recovery.
    ///
    /// # Errors
    /// Returns a storage error if a referenced attachment cannot be read.
    pub fn files_recover(&self) -> Result<(), Error> {
        let mut sessions = self.files.sessions.lock()?;
        sessions.retain(|_, session| session.touched.elapsed() < IDLE);
        let stage = self.files.stage()?;
        let conn = self.conn.lock()?;
        let mut stmt = conn.prepare("SELECT id,size FROM attachments")?;
        let ids = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        // A missing or truncated object is reported, never fatal: one damaged
        // attachment must not stop the whole library from opening.
        let mut damaged = 0u64;
        let mut removed = 0u64;
        for row in ids {
            let (id, size) = row?;
            let intact = AttachmentId::new(id)
                .ok()
                .and_then(|id| safe_file(&self.files.root.join(id.as_str()), &self.files.root).ok())
                .and_then(|file| file.metadata().ok())
                .is_some_and(|meta| i64::try_from(meta.len()).ok() == Some(size));
            if !intact {
                damaged += 1;
            }
        }
        for folder in [&self.files.root, &stage] {
            for entry in fs::read_dir(folder)? {
                let entry = entry?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                let orphan = if folder == &self.files.root {
                    // Never reclaim an object a note or version still links to,
                    // even when its metadata row is gone.
                    crate::id::is_valid_id(name) && !referenced(&conn, name)?
                } else {
                    name.ends_with(".part") && !sessions.values().any(|s| s.path == entry.path())
                };
                if !orphan || !entry.file_type()?.is_file() {
                    continue;
                }
                if let Ok(age) = entry.metadata()?.modified()?.elapsed()
                    && age >= RETENTION
                {
                    fs::remove_file(entry.path())?;
                    removed += 1;
                }
            }
        }
        tracing::info!(damaged, removed, "attachment.recovery.completed");
        Ok(())
    }

    /// Returns committed attachment metadata only.
    ///
    /// # Errors
    /// Returns not_found for absent IDs.
    pub fn files_get(&self, id: &AttachmentId) -> Result<Attachment, Error> {
        let conn = self.conn.lock()?;
        conn.query_row("SELECT id,note_id,filename,mime,size,width,height,sha256,created_at FROM attachments WHERE id=?1", [id.as_str()], attachment)
            .optional()?.ok_or_else(|| Error::NotFound { entity: Entity::Attachment, id: id.to_string() })
    }

    /// Opens a committed object with a checked filename and canonical location.
    ///
    /// # Errors
    /// Returns not_found or unavailable storage; never returns a stage file.
    pub fn files_open(&self, id: &AttachmentId) -> Result<(File, Attachment), Error> {
        let conn = self.conn.lock()?;
        let metadata = conn.query_row("SELECT id,note_id,filename,mime,size,width,height,sha256,created_at FROM attachments WHERE id=?1", [id.as_str()], attachment)
            .optional()?.ok_or_else(|| Error::NotFound { entity: Entity::Attachment, id: id.to_string() })?;
        let file = safe_file(&self.files.root.join(id.as_str()), &self.files.root)?;
        if file.metadata()?.len() != metadata.size {
            return Err(Error::invalid("id", "attachment size mismatch"));
        }
        Ok((file, metadata))
    }
    /// Reads an attachment bytes and integrity hash for synchronization.
    ///
    /// # Errors
    /// Returns not_found for absent metadata, rejects unsafe paths or mismatched
    /// sizes, and propagates filesystem read and SQLite errors.
    pub fn files_sync_source(
        &self,
        id: &AttachmentId,
    ) -> Result<(Vec<u8>, Attachment, String), Error> {
        use std::io::Read;
        let (mut file, metadata) = self.files_open(id)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        Ok((bytes, metadata, hash))
    }

    /// AutoNote `GET /files`: 500 per page, newest first, cursor `<createdAt>.<id>`.
    ///
    /// # Errors
    /// `bad_request` for a malformed cursor; SQLite errors on read failure.
    pub fn files_list(&self, cursor: Option<&str>) -> Result<crate::dto::AttachmentPage, Error> {
        const PAGE: usize = 500;
        let after = match cursor.filter(|c| !c.is_empty()) {
            None => None,
            Some(raw) => {
                let bad = || Error::invalid("cursor", "invalid attachment cursor");
                let (at, id) = raw.split_once('.').ok_or_else(bad)?;
                if at.is_empty() || at.len() > 16 || !at.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(bad());
                }
                let id: AttachmentId = id.parse().map_err(|_| bad())?;
                Some((at.parse::<i64>().map_err(|_| bad())?, id))
            }
        };
        let conn = self.conn.lock()?;
        let mut stmt = conn.prepare("SELECT id,note_id,filename,mime,size,width,height,sha256,created_at FROM attachments WHERE ?1 IS NULL OR created_at<?1 OR (created_at=?1 AND id<?2) ORDER BY created_at DESC,id DESC LIMIT ?3")?;
        let rows = stmt.query_map(
            rusqlite::params![
                after.as_ref().map(|a| a.0),
                after.as_ref().map(|a| a.1.as_str()),
                PAGE as i64 + 1
            ],
            attachment,
        )?;
        let mut files = Vec::new();
        for row in rows {
            let attachment = row?;
            let references: i64 = conn.query_row(
                "SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL AND instr(content, ?1)>0",
                [attachment.url.as_str()],
                |r| r.get(0),
            )?;
            files.push(AttachmentWithUsage {
                attachment,
                references: u64::try_from(references).map_err(|_| rusqlite::Error::InvalidQuery)?,
            });
        }
        let next_cursor = (files.len() > PAGE).then(|| {
            files.truncate(PAGE);
            let last = &files[PAGE - 1].attachment;
            format!("{}.{}", last.created_at.get(), last.id)
        });
        Ok(crate::dto::AttachmentPage { files, next_cursor })
    }

    /// Deletes metadata first; the physical object is reclaimed only after retention and DB reference checks.
    ///
    /// # Errors
    /// Returns not_found for a missing attachment.
    pub fn files_delete(&self, id: &AttachmentId) -> Result<(), Error> {
        let conn = self.conn.lock()?;
        let url = format!("/api/files/{id}");
        let referenced: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE instr(content, ?1)>0 UNION ALL SELECT 1 FROM note_versions WHERE instr(content, ?1)>0)", [url], |r| r.get(0))?;
        if referenced {
            return Err(Error::invalid("id", "attachment is referenced"));
        }
        if conn.execute("DELETE FROM attachments WHERE id=?1", [id.as_str()])? == 0 {
            return Err(Error::NotFound {
                entity: Entity::Attachment,
                id: id.to_string(),
            });
        }
        Ok(())
    }

    /// Removes unreferenced metadata and then reference-checks expired files/stages.
    ///
    /// # Errors
    /// Returns storage or SQLite errors without touching files outside the attachment root.
    pub fn files_prune(&self) -> Result<crate::dto::PruneResult, Error> {
        const UNREFERENCED: &str = "NOT EXISTS (SELECT 1 FROM notes WHERE instr(content, '/api/files/' || attachments.id)>0) AND NOT EXISTS (SELECT 1 FROM note_versions WHERE instr(content, '/api/files/' || attachments.id)>0)";
        let sessions = self.files.sessions.lock()?;
        let result = {
            let conn = self.conn.lock()?;
            let freed: i64 = conn.query_row(
                &format!("SELECT COALESCE(SUM(size),0) FROM attachments WHERE {UNREFERENCED}"),
                [],
                |r| r.get(0),
            )?;
            let removed =
                conn.execute(&format!("DELETE FROM attachments WHERE {UNREFERENCED}"), [])? as u64;
            crate::dto::PruneResult {
                removed,
                freed_bytes: freed as u64,
            }
        };
        drop(sessions);
        self.files_recover()?;
        Ok(result)
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
#[allow(
    clippy::unwrap_used,
    reason = "a failed unwrap is a failed attachment test"
)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::write::{ChangeSet, ChangeSink, RandomIds, WriteEvent};
    use crate::{LibraryDeps, SystemClock};

    struct Sink;
    impl ChangeSink for Sink {
        fn library_changed(&self, _: ChangeSet) {}
        fn write_event(&self, _: WriteEvent) {}
    }

    fn library(root: &Path) -> Library {
        Library::open_in_memory(
            root,
            LibraryDeps {
                clock: Arc::new(SystemClock),
                ids: Arc::new(RandomIds),
                sink: Arc::new(Sink),
            },
        )
        .unwrap()
    }

    fn upload(lib: &Library, bytes: &[u8]) -> Attachment {
        let begin = lib
            .files_upload_begin("main", "a.txt", "text/plain", bytes.len() as u64, None)
            .unwrap();
        lib.files_upload_chunk("main", &begin.upload_id, 0, bytes)
            .unwrap();
        lib.files_upload_finish("main", &begin.upload_id).unwrap()
    }

    #[test]
    fn sync_commits_verified_metadata_and_only_the_frozen_write() -> Result<(), Error> {
        use crate::sync::{Binding, SyncCookie, SyncEntity};
        use serde_json::json;
        let dir = tempfile::tempdir().unwrap();
        let lib = library(dir.path());
        let binding = Binding {
            binding_id: "test".into(),
            binding_epoch: 1,
            site_origin: "https://example.test".into(),
            account_hint: "test".into(),
            remote_user_id: "user".into(),
        };
        let cookie = SyncCookie {
            ciphertext: None,
            domain: "example.test".into(),
            path: "/".into(),
            expires_at: None,
            secure: true,
            host_only: true,
            name: "session".into(),
            same_site: "Lax".into(),
        };
        lib.sync_bind(&binding, &cookie).unwrap();
        let remote = "01arz3ndektsv4rrffq69g5fax";
        let hash = format!("{:x}", Sha256::digest(b"data"));
        let stage = || {
            let begin = lib
                .files_upload_begin("sync", "a.txt", "text/plain", 4, None)
                .unwrap();
            lib.files_upload_chunk("sync", &begin.upload_id, 0, b"data")
                .unwrap();
            begin
        };
        let begin = stage();
        assert!(
            lib.files_sync_finish("sync", &begin.upload_id, &binding, remote, "wrong")
                .is_err()
        );
        lib.conn.lock()?.execute_batch("CREATE TRIGGER reject_map BEFORE INSERT ON sync_attachment_map BEGIN SELECT RAISE(ABORT,'test'); END;")?;
        let begin = stage();
        assert!(
            lib.files_sync_finish("sync", &begin.upload_id, &binding, remote, &hash)
                .is_err()
        );
        assert_eq!(
            lib.conn
                .lock()?
                .query_row("SELECT COUNT(*) FROM attachments", [], |r| r
                    .get::<_, i64>(0))?,
            0
        );
        lib.conn.lock()?.execute_batch("DROP TRIGGER reject_map;")?;
        let begin = stage();
        let saved = lib
            .files_sync_finish("sync", &begin.upload_id, &binding, remote, &hash)
            .unwrap();
        let maps = lib.sync_attachment_maps(&binding).unwrap();
        assert_eq!(maps[0].local_attachment_id, saved.id.as_str());
        assert_eq!(maps[0].sha256, hash);
        let stale = Binding {
            binding_epoch: 2,
            ..binding.clone()
        };
        let begin = stage();
        assert!(
            lib.files_sync_finish("sync", &begin.upload_id, &stale, remote, &hash)
                .is_err()
        );
        let base = json!({"id":remote,"name":"old","color":null,"count":0,"createdAt":1});
        let payload = json!({"method":"PATCH","input":{"name":"new"},"base":base});
        let enqueue = |write: &str,
                       entity: &str,
                       payload: &serde_json::Value|
         -> Result<(), Error> {
            lib.conn.lock()?.execute("INSERT INTO sync_outbox(binding_id,binding_epoch,entity,write_id,local_id,local_rev,sent_local_rev,observed_cursor,ack_prereq,kind,payload,attachment_refs,next_attempt_at,state,created_at) VALUES('test',1,?1,?2,?3,0,0,0,'{}',?4,?5,'[]',0,'sending',1)",
                params![entity, write, remote, if entity == "note" { "patch" } else { "metadata" }, payload.to_string().as_bytes()])?;
            Ok(())
        };
        enqueue("recovery", "note", &json!({}))?;
        lib.sync_defer_outbox(&binding, "recovery", 1, "offline")?;
        assert_eq!(
            lib.conn.lock()?.query_row(
                "SELECT state FROM sync_outbox WHERE write_id='recovery'",
                [],
                |r| r.get::<_, String>(0)
            )?,
            "deferred"
        );
        let recovery = lib.sync_mark_recovery(&binding, "recovery").unwrap();
        assert!(crate::id::is_valid_id(&recovery));
        assert_eq!(
            recovery,
            lib.sync_mark_recovery(&binding, "recovery").unwrap()
        );
        enqueue("meta", "tag", &payload)?;
        let mut latest = base.clone();
        latest["count"] = json!(4);
        assert!(lib.sync_metadata_guard(&binding, "meta", &latest).unwrap());
        enqueue("newer", "tag", &payload)?;
        latest["name"] = json!("new");
        assert!(
            lib.sync_ack_metadata(&binding, "meta", 1, remote, &latest, 1)
                .is_err()
        );
        lib.sync_ack_metadata(&binding, "meta", 0, remote, &latest, 1)
            .unwrap();
        let map = lib
            .sync_map_for_local(&binding, SyncEntity::Tag, remote)
            .unwrap()
            .unwrap();
        assert_eq!(map.last_write_id.as_deref(), Some("meta"));
        assert_eq!(map.state, "dirty");
        assert!(!lib.sync_metadata_guard(&binding, "newer", &latest).unwrap());
        assert_eq!(lib.sync_conflicts().unwrap()[0].reason, "metadata_conflict");
        assert_eq!(lib.sync_state(&binding).unwrap().cursor, 0);
        lib.sync_confirm_binding(
            &binding,
            &cookie,
            crate::sync::BindPolicy::ExportLocal,
            &crate::sync::BindingSnapshot {
                notes: Vec::new(),
                folders: Vec::new(),
                tags: Vec::new(),
                cursor: 0,
            },
        )?;
        Ok(())
    }

    fn age(path: &Path) {
        let old = std::time::SystemTime::now() - RETENTION - Duration::from_secs(60);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }

    #[test]
    fn active_uploads_count_toward_quota_and_session_cap() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library(dir.path());
        let mut open = Vec::new();
        for _ in 0..MAX_SESSIONS {
            open.push(lib.files_upload_begin("main", "a", "", 1, None).unwrap());
        }
        assert!(
            lib.files_upload_begin("main", "a", "", 1, None).is_err(),
            "session cap"
        );
        for begin in &open {
            lib.files_upload_cancel("main", &begin.upload_id).unwrap();
        }
        // Committed usage leaves room for exactly one more MAX_BYTES upload.
        let used = (QUOTA_BYTES - MAX_BYTES) as i64;
        lib.conn.lock().unwrap().execute(
            "INSERT INTO attachments(id,filename,mime,size,sha256,created_at) VALUES('01arz3ndektsv4rrffq69g5fax','f','',?1,'',0)",
            [used],
        ).unwrap();
        let first = lib
            .files_upload_begin("main", "a", "", MAX_BYTES, None)
            .unwrap();
        assert!(
            matches!(
                lib.files_upload_begin("main", "a", "", 1, None),
                Err(Error::TooLarge { .. })
            ),
            "the in-flight upload already reserves the remaining quota"
        );
        lib.files_upload_cancel("main", &first.upload_id).unwrap();
        assert!(
            lib.files_upload_begin("main", "a", "", 1, None).is_ok(),
            "cancel releases it"
        );
    }

    #[test]
    fn recovery_keeps_objects_still_linked_from_notes_or_versions() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library(dir.path());
        let linked: AttachmentId = "01arz3ndektsv4rrffq69g5fav".parse().unwrap();
        let orphan: AttachmentId = "01arz3ndektsv4rrffq69g5faw".parse().unwrap();
        for id in [&linked, &orphan] {
            fs::write(dir.path().join(id.as_str()), b"x").unwrap();
            age(&dir.path().join(id.as_str()));
        }
        lib.create_note(
            &crate::NewNote {
                id: None,
                title: None,
                content: format!("![x](/api/files/{linked})"),
                folder_id: None,
                is_starred: false,
            },
            crate::WriteOrigin::Ui,
        )
        .unwrap();
        lib.files_recover().unwrap();
        assert!(
            dir.path().join(linked.as_str()).exists(),
            "linked object kept"
        );
        assert!(
            !dir.path().join(orphan.as_str()).exists(),
            "true orphan reclaimed"
        );
    }

    #[test]
    fn upload_enforces_size_offset_window_and_single_use() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library(dir.path());
        assert!(matches!(
            lib.files_upload_begin("main", "big", "", MAX_BYTES + 1, None),
            Err(Error::TooLarge { .. })
        ));
        let begin = lib
            .files_upload_begin("main", "a.txt", "text/plain", 4, None)
            .unwrap();
        let id = &begin.upload_id;
        assert!(lib.files_upload_chunk("other", id, 0, b"ab").is_err());
        assert!(lib.files_upload_chunk("main", id, 1, b"ab").is_err());
        assert!(matches!(
            lib.files_upload_chunk("main", id, 0, b"abcde"),
            Err(Error::TooLarge { .. })
        ));
        assert_eq!(lib.files_upload_chunk("main", id, 0, b"ab").unwrap(), 2);
        assert!(
            lib.files_upload_finish("main", id).is_err(),
            "incomplete upload must not publish"
        );
        assert_eq!(lib.files_upload_chunk("main", id, 2, b"cd").unwrap(), 4);
        assert!(lib.files_upload_finish("other", id).is_err());
        let saved = lib.files_upload_finish("main", id).unwrap();
        assert!(
            lib.files_upload_finish("main", id).is_err(),
            "uploadId is single use"
        );
        let (mut file, meta) = lib.files_open(&saved.id).unwrap();
        let mut body = String::new();
        std::io::Read::read_to_string(&mut file, &mut body).unwrap();
        assert_eq!((body.as_str(), meta.size), ("abcd", 4));
    }

    #[test]
    fn traversal_and_illegal_ids_never_reach_the_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("secret"), b"x").unwrap();
        for raw in [
            "../secret",
            "..\\secret",
            "secret",
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "",
        ] {
            assert!(
                AttachmentId::new(raw.to_owned()).is_err(),
                "{raw} must be rejected"
            );
        }
        let lib = library(&dir.path().join("files"));
        let unregistered: AttachmentId = "01arz3ndektsv4rrffq69g5fav".parse().unwrap();
        fs::write(dir.path().join("files").join(unregistered.as_str()), b"x").unwrap();
        assert!(matches!(
            lib.files_open(&unregistered),
            Err(Error::NotFound { .. })
        ));
    }

    #[test]
    fn stage_files_are_never_served() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library(dir.path());
        let begin = lib
            .files_upload_begin("main", "a.txt", "text/plain", 2, None)
            .unwrap();
        lib.files_upload_chunk("main", &begin.upload_id, 0, b"ab")
            .unwrap();
        let staged = fs::read_dir(dir.path().join(".stage"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        let name = staged.file_name().into_string().unwrap();
        let id = name
            .split('.')
            .next()
            .unwrap()
            .parse::<AttachmentId>()
            .unwrap();
        assert!(matches!(lib.files_open(&id), Err(Error::NotFound { .. })));
    }

    #[test]
    fn db_failure_after_publish_keeps_the_object_for_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library(dir.path());
        let note = lib
            .create_note(
                &crate::NewNote {
                    id: None,
                    title: None,
                    content: String::new(),
                    folder_id: None,
                    is_starred: false,
                },
                crate::WriteOrigin::Ui,
            )
            .unwrap()
            .value
            .summary
            .id;
        let begin = lib
            .files_upload_begin("main", "a.txt", "text/plain", 2, Some(note.clone()))
            .unwrap();
        lib.files_upload_chunk("main", &begin.upload_id, 0, b"ab")
            .unwrap();
        lib.trash_note(&note, crate::WriteOrigin::Ui).unwrap();
        assert!(lib.files_upload_finish("main", &begin.upload_id).is_err());
        let published: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.unwrap().file_name().into_string().ok())
            .filter(|n| crate::id::is_valid_id(n))
            .collect();
        assert_eq!(
            published.len(),
            1,
            "a failed commit leaves the file in place"
        );
        lib.files_recover().unwrap();
        assert!(
            dir.path().join(&published[0]).exists(),
            "young orphans are kept for recovery"
        );
    }

    #[test]
    fn prune_spares_references_young_orphans_and_foreign_files() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library(dir.path());
        let kept = upload(&lib, b"kept");
        lib.create_note(
            &crate::NewNote {
                id: None,
                title: None,
                content: format!("![x]({})", kept.url),
                folder_id: None,
                is_starred: false,
            },
            crate::WriteOrigin::Ui,
        )
        .unwrap();
        let dropped = upload(&lib, b"gone");
        let young: AttachmentId = "01arz3ndektsv4rrffq69g5fav".parse().unwrap();
        let old: AttachmentId = "01arz3ndektsv4rrffq69g5faw".parse().unwrap();
        fs::write(dir.path().join(young.as_str()), b"y").unwrap();
        fs::write(dir.path().join(old.as_str()), b"o").unwrap();
        fs::write(dir.path().join("notes.md"), b"user data").unwrap();
        age(&dir.path().join(old.as_str()));
        age(&dir.path().join("notes.md"));
        age(&dir.path().join(dropped.id.as_str()));

        let page = lib.files_list(None).unwrap();
        assert_eq!((page.files.len(), page.next_cursor), (2, None));
        assert_eq!(
            page.files
                .iter()
                .find(|f| f.attachment.id == kept.id)
                .unwrap()
                .references,
            1
        );
        assert!(matches!(
            lib.files_list(Some("x.y")),
            Err(Error::InvalidInput { .. })
        ));
        assert_eq!(
            lib.files_prune().unwrap(),
            crate::dto::PruneResult {
                removed: 1,
                freed_bytes: 4
            }
        );
        assert!(lib.files_open(&kept.id).is_ok());
        assert!(matches!(
            lib.files_open(&dropped.id),
            Err(Error::NotFound { .. })
        ));
        assert!(
            !dir.path().join(dropped.id.as_str()).exists(),
            "expired unreferenced object reclaimed"
        );
        assert!(
            dir.path().join(young.as_str()).exists(),
            "orphan inside retention window kept"
        );
        assert!(!dir.path().join(old.as_str()).exists());
        assert!(
            dir.path().join("notes.md").exists(),
            "non-attachment names are never touched"
        );
    }

    #[test]
    fn missing_object_does_not_block_opening_the_library() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library(dir.path());
        let saved = upload(&lib, b"ab");
        fs::remove_file(dir.path().join(saved.id.as_str())).unwrap();
        lib.files_recover().unwrap();
        assert!(lib.files_open(&saved.id).is_err());
    }
}
