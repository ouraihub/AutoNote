use super::*;

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
            tx.execute(
                "INSERT INTO attachments(\
                 id,note_id,filename,mime,size,sha256,created_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![id, note_id, filename, mime, bytes.len() as i64, hash, now],
            )?;
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
