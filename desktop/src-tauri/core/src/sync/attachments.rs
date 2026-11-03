use super::binding::require_binding;
use crate::error::Error;
use rusqlite::{Connection, OptionalExtension, params};

impl crate::db::Library {
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_attachment_remote(&self, local_id: &str) -> Result<Option<String>, Error> {
        Ok(self
            .conn
            .lock()?
            .query_row(
                "SELECT remote_id FROM sync_attachment WHERE local_id=?1",
                [local_id],
                |r| r.get(0),
            )
            .optional()?)
    }
    /// Local attachment id for a remote one.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_attachment_local(&self, remote_id: &str) -> Result<Option<String>, Error> {
        Ok(self
            .conn
            .lock()?
            .query_row(
                "SELECT local_id FROM sync_attachment WHERE remote_id=?1",
                [remote_id],
                |r| r.get(0),
            )
            .optional()?)
    }
    /// Maps a downloaded remote file to an identical local one, if any, so a
    /// rebind reuses files instead of duplicating them. Returns the local id.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_adopt_attachment(
        &self,
        remote_id: &str,
        sha256: &str,
        size: u64,
    ) -> Result<Option<String>, Error> {
        let conn = self.conn.lock()?;
        let size = i64::try_from(size).unwrap_or(i64::MAX);
        let local: Option<String> = conn
            .query_row(
                concat!(
                    "SELECT id FROM attachments WHERE sha256=?1 AND size=?2 AND ",
                    "id NOT IN (SELECT local_id FROM sync_attachment) ",
                    "ORDER BY created_at,id LIMIT 1",
                ),
                params![sha256, size],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(local) = &local {
            insert_attachment_map(&conn, local, remote_id, sha256, size.unsigned_abs())?;
        }
        Ok(local)
    }
    /// Records the remote id of an uploaded local attachment.
    ///
    /// # Errors
    /// Rejects a missing binding or a remote id mapped to another file.
    pub fn sync_attachment_map(
        &self,
        local_id: &str,
        remote_id: &str,
        sha256: &str,
        size: u64,
    ) -> Result<(), Error> {
        let conn = self.conn.lock()?;
        require_binding(&conn)?;
        insert_attachment_map(&conn, local_id, remote_id, sha256, size)
    }
}

pub(crate) fn insert_attachment_map(
    conn: &Connection,
    local_id: &str,
    remote_id: &str,
    sha256: &str,
    size: u64,
) -> Result<(), Error> {
    if !crate::id::is_valid_id(remote_id) {
        return Err(Error::invalid("remoteId", "must be a valid attachment id"));
    }
    conn.execute(
        concat!(
            "INSERT INTO sync_attachment(local_id,remote_id,sha256,size) VALUES(?1,?2,?3,?4) ",
            "ON CONFLICT(local_id) DO UPDATE SET remote_id=excluded.remote_id,",
            "sha256=excluded.sha256,size=excluded.size",
        ),
        params![
            local_id,
            remote_id,
            sha256,
            i64::try_from(size).unwrap_or(i64::MAX)
        ],
    )?;
    Ok(())
}
