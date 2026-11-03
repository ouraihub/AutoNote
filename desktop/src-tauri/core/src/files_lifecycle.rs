use super::*;
impl Library {
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
        conn.query_row(
            "SELECT id,note_id,filename,mime,size,width,height,sha256,created_at \
             FROM attachments WHERE id=?1",
            [id.as_str()],
            attachment,
        )
        .optional()?
        .ok_or_else(|| Error::NotFound {
            entity: Entity::Attachment,
            id: id.to_string(),
        })
    }

    /// Opens a committed object with a checked filename and canonical location.
    ///
    /// # Errors
    /// Returns not_found or unavailable storage; never returns a stage file.
    pub fn files_open(&self, id: &AttachmentId) -> Result<(File, Attachment), Error> {
        let conn = self.conn.lock()?;
        let metadata = conn
            .query_row(
                "SELECT id,note_id,filename,mime,size,width,height,sha256,created_at \
                 FROM attachments WHERE id=?1",
                [id.as_str()],
                attachment,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound {
                entity: Entity::Attachment,
                id: id.to_string(),
            })?;
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

    /// Mirrors Web `GET /files`: 500 per page, newest first, cursor `<createdAt>.<id>`.
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
        let mut stmt = conn.prepare(
            "SELECT id,note_id,filename,mime,size,width,height,sha256,created_at \
             FROM attachments WHERE ?1 IS NULL OR created_at<?1 \
             OR (created_at=?1 AND id<?2) ORDER BY created_at DESC,id DESC LIMIT ?3",
        )?;
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

    /// Deletes metadata first; the physical object is reclaimed only after
    /// retention and DB reference checks.
    ///
    /// # Errors
    /// Returns not_found for a missing attachment.
    pub fn files_delete(&self, id: &AttachmentId) -> Result<(), Error> {
        let conn = self.conn.lock()?;
        let url = format!("/api/files/{id}");
        let referenced: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE instr(content, ?1)>0 \
             UNION ALL SELECT 1 FROM note_versions WHERE instr(content, ?1)>0)",
            [url],
            |r| r.get(0),
        )?;
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
    /// Returns storage or SQLite errors without touching files outside the
    /// attachment root.
    pub fn files_prune(&self) -> Result<crate::dto::PruneResult, Error> {
        const UNREFERENCED: &str = "NOT EXISTS (SELECT 1 FROM notes \
             WHERE instr(content, '/api/files/' || \
             attachments.id)>0) AND NOT EXISTS (SELECT 1 FROM note_versions \
             WHERE instr(content, '/api/files/' || attachments.id)>0)";
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
