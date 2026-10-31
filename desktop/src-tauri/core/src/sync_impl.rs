use super::*;
#[path = "sync_api.rs"]
mod sync_api;
#[path = "sync_helpers.rs"]
mod sync_helpers;

fn load_binding(conn: &Connection) -> Result<Option<BindingState>, Error> {
    Ok(conn
        .query_row(
            "SELECT site_origin,account_hint,remote_user_id,cookie_ciphertext,cookie_name,cookie_domain,cookie_path,cookie_expires_at,cookie_secure,cookie_host_only,cookie_same_site,cursor,last_success_at,last_error_code FROM sync_binding WHERE id=1",
            [],
            |r| {
                Ok(BindingState {
                    binding: Binding {
                        site_origin: r.get(0)?,
                        account_hint: r.get(1)?,
                        remote_user_id: r.get(2)?,
                    },
                    cookie: SyncCookie {
                        ciphertext: r.get(3)?,
                        name: r.get(4)?,
                        domain: r.get(5)?,
                        path: r.get(6)?,
                        expires_at: r.get(7)?,
                        secure: r.get(8)?,
                        host_only: r.get(9)?,
                        same_site: r.get(10)?,
                    },
                    cursor: r.get(11)?,
                    last_success_at: r.get(12)?,
                    last_error_code: r.get(13)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn require_binding(conn: &Connection) -> Result<(), Error> {
    let bound: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_binding)", [], |r| {
        r.get(0)
    })?;
    if bound {
        Ok(())
    } else {
        Err(Error::invalid("binding", "sync is not bound"))
    }
}

fn valid_binding(binding: &Binding, cookie: &SyncCookie) -> Result<(), Error> {
    if binding.site_origin.is_empty() || binding.site_origin.len() > 2048 {
        return Err(Error::invalid("siteOrigin", "is required"));
    }
    if binding.remote_user_id.is_empty() || binding.remote_user_id.len() > 128 {
        return Err(Error::invalid("remoteUserId", "is required"));
    }
    if cookie.ciphertext.is_empty() || cookie.name.is_empty() {
        return Err(Error::invalid("cookie", "encrypted session is required"));
    }
    Ok(())
}

fn dirty_row(conn: &Connection, entity: DirtyEntity, id: &str) -> Result<LocalRow, Error> {
    Ok(match entity {
        DirtyEntity::Note => load_note(conn, id)?.map_or(LocalRow::Missing, LocalRow::Note),
        DirtyEntity::Folder => conn
            .query_row(
                &format!(
                    "SELECT {} FROM folders f WHERE f.id=?1 AND f.deleted_at IS NULL",
                    crate::db::rows::FOLDER_COLUMNS
                ),
                [id],
                crate::db::rows::folder,
            )
            .optional()?
            .map_or(LocalRow::Missing, LocalRow::Folder),
        DirtyEntity::Tag => conn
            .query_row(
                &format!(
                    "SELECT {} FROM tags t WHERE t.id=?1",
                    crate::db::rows::TAG_COLUMNS
                ),
                [id],
                crate::db::rows::tag,
            )
            .optional()?
            .map_or(LocalRow::Missing, LocalRow::Tag),
    })
}

impl crate::db::Library {
    /// Dirty rows in push order (22 §7.3): live folders parents first, live tags,
    /// notes, then deleted notes, tags and folders children first.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_dirty(&self) -> Result<Vec<DirtyItem>, Error> {
        let conn = self.conn.lock()?;
        let depths = folder_depths(&conn)?;
        let mut stmt = conn.prepare("SELECT entity,id,remote_rev FROM sync_item WHERE dirty=1")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    entity_parse(&r.get::<_, String>(0)?)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut items = Vec::with_capacity(rows.len());
        for (entity, id, remote_rev) in rows {
            let row = dirty_row(&conn, entity, &id)?;
            let seen = seen(&conn, entity, &id)?;
            items.push(DirtyItem {
                entity,
                id,
                remote_rev,
                row,
                seen,
            });
        }
        let rank = |item: &DirtyItem| -> (u8, i64) {
            let depth = depths.get(&item.id).copied().unwrap_or(0) as i64;
            match (item.entity, matches!(item.row, LocalRow::Missing)) {
                (DirtyEntity::Folder, false) => (0, depth),
                (DirtyEntity::Tag, false) => (1, 0),
                (DirtyEntity::Note, false) => (2, 0),
                (DirtyEntity::Note, true) => (3, 0),
                (DirtyEntity::Tag, true) => (4, 0),
                (DirtyEntity::Folder, true) => (5, -depth),
            }
        };
        items.sort_by_key(|item| rank(item));
        Ok(items)
    }
    /// Push succeeded: records the remote rev and clears `dirty` unless the row
    /// changed since `seen` was read. A row that is gone everywhere is forgotten.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_settle(
        &self,
        entity: DirtyEntity,
        id: &str,
        remote_rev: Option<i64>,
        seen_token: &str,
    ) -> Result<(), Error> {
        let mut conn = self.conn.lock()?;
        let tx = conn.transaction()?;
        let now = seen(&tx, entity, id)?;
        if now != seen_token {
            tx.execute(
                "UPDATE sync_item SET remote_rev=?3 WHERE entity=?1 AND id=?2",
                params![entity.as_str(), id, remote_rev],
            )?;
        } else if now.is_empty() {
            forget(&tx, entity, id)?;
        } else {
            set_item(&tx, entity, id, remote_rev, false)?;
        }
        tx.commit()?;
        Ok(())
    }
    /// The remote no longer has this note; the next push creates it again.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_forget_remote(&self, id: &str) -> Result<(), Error> {
        self.conn.lock()?.execute(
            "UPDATE sync_item SET remote_rev=NULL WHERE entity='note' AND id=?1",
            [id],
        )?;
        Ok(())
    }
    /// A real 409 conflict (22 §7.3): the local version becomes a pending copy
    /// and the original id takes the server version. `server` must reference
    /// local attachment ids. Returns `false` when the row changed since `seen`.
    ///
    /// # Errors
    /// Rejects invalid server rows; everything rolls back.
    pub fn sync_fork_conflict(&self, server: &Note, seen_token: &str) -> Result<bool, Error> {
        let id = server.summary.id.as_str();
        Ok(self
            .write(WriteOrigin::Sync, |w| {
                if seen(&w.tx, DirtyEntity::Note, id)? != seen_token {
                    return Ok(false);
                }
                if let Some(local) = load_note(&w.tx, id)? {
                    fork_copy(w, &local)?;
                }
                put_note(w, id, server)?;
                set_item(
                    &w.tx,
                    DirtyEntity::Note,
                    id,
                    Some(server.summary.rev.get()),
                    false,
                )?;
                Ok(true)
            })?
            .value)
    }
    /// Adopts the remote tag that already owns this name, merging the local tag into it.
    ///
    /// # Errors
    /// Rejects an invalid remote tag; everything rolls back.
    pub fn sync_adopt_tag(&self, local_id: &str, remote: &Tag) -> Result<(), Error> {
        self.write(WriteOrigin::Sync, |w| {
            put_tag(w, remote)?;
            forget(&w.tx, DirtyEntity::Tag, local_id)?;
            set_item(&w.tx, DirtyEntity::Tag, remote.id.as_str(), None, false)
        })?;
        Ok(())
    }
    /// Remote attachment id for a local one.
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
                "SELECT id FROM attachments WHERE sha256=?1 AND size=?2 AND id NOT IN (SELECT local_id FROM sync_attachment) ORDER BY created_at,id LIMIT 1",
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
        "INSERT INTO sync_attachment(local_id,remote_id,sha256,size) VALUES(?1,?2,?3,?4) ON CONFLICT(local_id) DO UPDATE SET remote_id=excluded.remote_id,sha256=excluded.sha256,size=excluded.size",
        params![local_id, remote_id, sha256, i64::try_from(size).unwrap_or(i64::MAX)],
    )?;
    Ok(())
}

