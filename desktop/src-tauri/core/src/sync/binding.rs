use super::apply::apply_batch;
use super::models::{Binding, BindingState, MergeCounts, RemoteBatch, SyncCookie};
use super::storage::{load_note, same_note};
use crate::dto::Note;
use crate::error::Error;
use crate::write::WriteOrigin;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashSet;

pub(super) fn load_binding(conn: &Connection) -> Result<Option<BindingState>, Error> {
    Ok(conn
        .query_row(
            concat!(
                "SELECT site_origin,account_hint,remote_user_id,cookie_ciphertext,",
                "cookie_name,cookie_domain,cookie_path,cookie_expires_at,cookie_secure,",
                "cookie_host_only,cookie_same_site,cursor,last_success_at,last_error_code ",
                "FROM sync_binding WHERE id=1",
            ),
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

pub(super) fn valid_binding(binding: &Binding, cookie: &SyncCookie) -> Result<(), Error> {
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

impl crate::db::Library {
    /// A fresh random id for short-lived sync handles (login, preview).
    ///
    /// # Errors
    /// Returns a lock, clock or SQLite error.
    pub fn sync_new_id(&self) -> Result<String, Error> {
        let conn = self.conn.lock()?;
        let tx = conn.unchecked_transaction()?;
        let id = crate::write::new_id(self.ids.as_ref(), self.clock.now()?, &tx)?;
        tx.commit()?;
        Ok(id)
    }
    /// Returns the current binding, if any.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_binding(&self) -> Result<Option<BindingState>, Error> {
        load_binding(&*self.conn.lock()?)
    }
    /// Number of rows awaiting push.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_pending(&self) -> Result<u64, Error> {
        let n: i64 = self.conn.lock()?.query_row(
            "SELECT COUNT(*) FROM sync_item WHERE dirty=1",
            [],
            |r| r.get(0),
        )?;
        Ok(u64::try_from(n).unwrap_or(0))
    }
    /// Compares a remote snapshot with local notes by id; writes nothing.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_merge_counts(&self, remote: &[Note]) -> Result<MergeCounts, Error> {
        let conn = self.conn.lock()?;
        let mut counts = MergeCounts::default();
        let mut seen_ids = HashSet::with_capacity(remote.len());
        for note in remote {
            seen_ids.insert(note.summary.id.as_str());
            match load_note(&conn, note.summary.id.as_str())? {
                None => counts.remote_only += 1,
                Some(local) if same_note(&local, note) => counts.same += 1,
                Some(_) => counts.different += 1,
            }
        }
        let mut stmt = conn.prepare("SELECT id FROM notes")?;
        for id in stmt.query_map([], |r| r.get::<_, String>(0))? {
            if !seen_ids.contains(id?.as_str()) {
                counts.local_only += 1;
            }
        }
        Ok(counts)
    }
    /// Creates the binding and merges the remote snapshot (22 §6.4) in one transaction.
    ///
    /// # Errors
    /// Rejects an existing binding, invalid input or remote rows; SQLite errors roll back.
    pub fn sync_bind(
        &self,
        binding: &Binding,
        cookie: &SyncCookie,
        snapshot: &RemoteBatch,
    ) -> Result<(), Error> {
        valid_binding(binding, cookie)?;
        self.write(WriteOrigin::Sync, |w| {
            let bound: bool =
                w.tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_binding)", [], |r| {
                    r.get(0)
                })?;
            if bound {
                return Err(Error::invalid("binding", "already bound; unbind first"));
            }
            w.tx.execute(
                concat!(
                    "INSERT INTO sync_binding(id,site_origin,account_hint,remote_user_id,",
                    "cookie_ciphertext,cookie_name,cookie_domain,cookie_path,cookie_expires_at,",
                    "cookie_secure,cookie_host_only,cookie_same_site,cursor,created_at) ",
                    "VALUES(1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12)",
                ),
                params![
                    binding.site_origin,
                    binding.account_hint,
                    binding.remote_user_id,
                    cookie.ciphertext,
                    cookie.name,
                    cookie.domain,
                    cookie.path,
                    cookie.expires_at,
                    cookie.secure,
                    cookie.host_only,
                    cookie.same_site,
                    w.now.get(),
                ],
            )?;
            apply_batch(w, snapshot, true)
        })?;
        Ok(())
    }
    /// Removes the binding; local data stays and everything becomes pending again.
    ///
    /// # Errors
    /// Returns a lock or SQLite error.
    pub fn sync_unbind(&self) -> Result<(), Error> {
        let mut conn = self.conn.lock()?;
        let tx = conn.transaction()?;
        tx.execute_batch(
            "DELETE FROM sync_binding;\
             DELETE FROM sync_attachment;\
             DELETE FROM sync_item WHERE (entity='note' AND id NOT IN (SELECT id FROM notes))\
               OR (entity='folder' AND id NOT IN (SELECT id FROM folders WHERE deleted_at IS NULL))\
               OR (entity='tag' AND id NOT IN (SELECT id FROM tags));\
             UPDATE sync_item SET dirty=1, remote_rev=NULL;",
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Stores a renewed encrypted session cookie.
    ///
    /// # Errors
    /// Rejects a missing binding; returns lock or SQLite errors.
    pub fn sync_set_cookie(&self, cookie: &SyncCookie) -> Result<(), Error> {
        let conn = self.conn.lock()?;
        require_binding(&conn)?;
        conn.execute(
            concat!(
                "UPDATE sync_binding SET cookie_ciphertext=?1,cookie_name=?2,",
                "cookie_domain=?3,cookie_path=?4,cookie_expires_at=?5,cookie_secure=?6,",
                "cookie_host_only=?7,cookie_same_site=?8 WHERE id=1",
            ),
            params![
                cookie.ciphertext,
                cookie.name,
                cookie.domain,
                cookie.path,
                cookie.expires_at,
                cookie.secure,
                cookie.host_only,
                cookie.same_site,
            ],
        )?;
        Ok(())
    }
    /// Records one round's outcome: success clears the error and stamps the time.
    ///
    /// # Errors
    /// Returns lock, clock or SQLite errors.
    pub fn sync_record_result(&self, error_code: Option<&str>) -> Result<(), Error> {
        let now = self.clock.now()?.get();
        let conn = self.conn.lock()?;
        match error_code {
            None => conn.execute(
                "UPDATE sync_binding SET last_error_code=NULL,last_success_at=?1 WHERE id=1",
                [now],
            )?,
            Some(code) => conn.execute(
                "UPDATE sync_binding SET last_error_code=?1 WHERE id=1",
                [code],
            )?,
        };
        Ok(())
    }
    /// Applies remote rows and advances the cursor in one transaction (22 §7.2).
    ///
    /// # Errors
    /// Rejects a missing binding or invalid remote rows; everything rolls back.
    pub fn sync_apply(&self, batch: &RemoteBatch) -> Result<(), Error> {
        self.write(WriteOrigin::Sync, |w| {
            require_binding(&w.tx)?;
            apply_batch(w, batch, false)
        })?;
        Ok(())
    }
}
