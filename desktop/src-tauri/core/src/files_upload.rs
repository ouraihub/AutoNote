use super::*;
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

    /// Publishes a verified download and its remote-id mapping together.
    /// The digest proves local integrity, not authenticity of remote bytes.
    ///
    /// # Errors
    /// Rejects invalid IDs, unknown/foreign/incomplete uploads or a digest
    /// mismatch. Filesystem and SQLite failures abort publication.
    pub fn files_sync_finish(
        &self,
        window: &str,
        upload_id: &str,
        remote_id: &str,
        sha256: &str,
    ) -> Result<Attachment, Error> {
        if !crate::id::is_valid_id(remote_id) {
            return Err(Error::invalid("remoteId", "must be a valid attachment id"));
        }
        self.files_finish(window, upload_id, Some((remote_id, sha256)))
    }

    fn files_finish(
        &self,
        window: &str,
        upload_id: &str,
        mapping: Option<(&str, &str)>,
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
        if mapping.is_some_and(|(_, expected)| expected != hash) {
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
            tx.execute(
                "INSERT INTO attachments (\
                 id,note_id,filename,mime,size,sha256,created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    session.id.as_str(),
                    session.note_id.as_ref().map(NoteId::as_str),
                    session.filename,
                    mime,
                    session.size as i64,
                    hash,
                    session.created_at.get(),
                ],
            )?;
            if let Some((remote_id, _)) = mapping {
                crate::sync::insert_attachment_map(
                    &tx,
                    session.id.as_str(),
                    remote_id,
                    &hash,
                    session.size,
                )?;
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
}
