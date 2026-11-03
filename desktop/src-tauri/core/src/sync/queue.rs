use super::apply::folder_depths;
use super::models::{DirtyItem, LocalRow};
use super::storage::{entity_parse, forget, load_note, seen, set_item};
use super::storage::{fork_copy, put_note, put_tag};
use crate::dto::{Note, Tag};
use crate::error::Error;
use crate::write::{DirtyEntity, WriteOrigin};
use rusqlite::{Connection, OptionalExtension, params};

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
}
