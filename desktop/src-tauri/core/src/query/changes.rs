//! Local snapshots and bounded incremental notifications under one connection lock.
use crate::db::Library;
use crate::db::rows::{FOLDER_COLUMNS, NOTE_COLUMNS, TAG_COLUMNS, folder, note_summary, tag};
use crate::dto::{DeletedEntity, Folder, NoteSummary, SyncDeletion, SyncResponse, Tag};
use crate::error::Error;
use crate::types::Cursor;
use rusqlite::{Connection, OptionalExtension};

fn cursor(conn: &Connection) -> Result<Cursor, Error> {
    let seq: Option<i64> = conn.query_row("SELECT MAX(seq) FROM changes", [], |row| row.get(0))?;
    Cursor::new(seq.unwrap_or(0))
}
fn facets(conn: &Connection) -> Result<(Vec<Folder>, Vec<Tag>), Error> {
    let sql = format!(
        "SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.deleted_at IS NULL ORDER BY f.parent_id, f.position, f.id"
    );
    let folders = conn
        .prepare(&sql)?
        .query_map([], folder)?
        .collect::<rusqlite::Result<_>>()?;
    let sql = format!("SELECT {TAG_COLUMNS} FROM tags t ORDER BY t.name COLLATE NOCASE, t.id");
    let tags = conn
        .prepare(&sql)?
        .query_map([], tag)?
        .collect::<rusqlite::Result<_>>()?;
    Ok((folders, tags))
}
fn notes(conn: &Connection, since: Option<i64>, until: i64) -> Result<Vec<NoteSummary>, Error> {
    let sql = match since {
        None => format!("SELECT {NOTE_COLUMNS} FROM notes n ORDER BY n.updated_at DESC, n.id"),
        Some(_) => format!(
            "SELECT {NOTE_COLUMNS} FROM notes n WHERE n.id IN (SELECT entity_id FROM changes WHERE seq > ?1 AND seq <= ?2 AND entity='note' AND op='upsert') ORDER BY n.updated_at DESC, n.id"
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows: rusqlite::Result<Vec<_>> = match since {
        None => stmt.query_map([], note_summary)?.collect(),
        Some(since) => stmt.query_map([since, until], note_summary)?.collect(),
    };
    Ok(rows?)
}
fn deletions(conn: &Connection, since: i64, until: i64) -> Result<Vec<SyncDeletion>, Error> {
    let mut stmt = conn.prepare("SELECT DISTINCT c.entity_id FROM changes c WHERE c.seq > ?1 AND c.seq <= ?2 AND c.entity='note' AND c.op='delete' AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = c.entity_id) ORDER BY c.entity_id")?;
    stmt.query_map([since, until], |row| row.get::<_, String>(0))?
        .map(|id| {
            Ok(SyncDeletion {
                entity: DeletedEntity::Note,
                id: id?,
            })
        })
        .collect()
}
impl Library {
    fn sync_response(&self, since: Option<i64>) -> Result<SyncResponse, Error> {
        let server_time = self.clock.now()?;
        self.read(|conn| {
            let latest = cursor(conn)?;
            let since = match since {
                Some(since) if !stale(conn, since, latest.get())? => Some(since),
                _ => None,
            };
            // Incremental import notifications stay bounded; an explicit full
            // snapshot still returns the complete UI summary collection.
            let end = match since {
                Some(since) => conn.query_row("SELECT MAX(seq) FROM (SELECT seq FROM changes WHERE seq > ?1 ORDER BY seq LIMIT 500)", [since], |row| row.get::<_, Option<i64>>(0))?.unwrap_or(since),
                None => latest.get(),
            };
            let cursor = Cursor::new(end)?;
            let (folders, tags) = facets(conn)?;
            let settings_changed = match since {
                None => true,
                Some(since) => conn.query_row("SELECT 1 FROM changes WHERE seq > ?1 AND seq <= ?2 AND entity='settings' LIMIT 1", [since, end], |_| Ok(())).optional()?.is_some(),
            };
            Ok(SyncResponse { cursor, full: since.is_none(), has_more: end < latest.get(), next_key: None, facets_full: true, settings_changed, profile_changed: None, site_changed: None, notes: notes(conn, since, end)?, folders, tags, deletions: since.map_or(Ok(Vec::new()), |since| deletions(conn, since, end))?, server_time })
        })
    }
    /// Complete local summary snapshot, without bodies.
    /// # Errors
    /// Returns SQLite or row-decoding errors.
    pub fn notes_snapshot(&self) -> Result<SyncResponse, Error> {
        self.sync_response(None)
    }
    /// Current local change-feed position.
    /// # Errors
    /// Returns SQLite errors.
    pub fn library_cursor(&self) -> Result<Cursor, Error> {
        self.read(cursor)
    }
    /// Incremental changes; stale cursors receive a complete snapshot.
    /// # Errors
    /// Returns SQLite or row-decoding errors.
    pub fn library_changes(&self, since: Cursor) -> Result<SyncResponse, Error> {
        self.sync_response(Some(since.get()))
    }
}
fn stale(conn: &Connection, since: i64, latest: i64) -> Result<bool, Error> {
    if since <= 0 || since > latest {
        return Ok(true);
    }
    let oldest: Option<i64> =
        conn.query_row("SELECT MIN(seq) FROM changes", [], |row| row.get(0))?;
    Ok(oldest.is_some_and(|oldest| since < oldest - 1))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "isolated pagination regression"
)]
mod tests {
    use super::*;
    #[test]
    fn change_pages_advance_after_large_commits() {
        let root = tempfile::tempdir().expect("directory");
        let library = Library::open(&root.path().join("library.db")).expect("library");
        library.read(|conn| {
            conn.execute("INSERT INTO changes(entity,entity_id,op,at) VALUES ('settings','appearance','upsert',1)", [])?;
            for _ in 0..1200 { conn.execute("INSERT INTO changes(entity,entity_id,op,at) VALUES ('settings','appearance','upsert',1)", [])?; }
            Ok(())
        }).expect("changes");
        let mut since = Cursor::new(1).expect("cursor");
        let mut pages = 0;
        loop {
            let page = library.library_changes(since).expect("page");
            assert!(!page.full);
            assert!(page.cursor.get() > since.get());
            assert!(page.cursor.get() - since.get() <= 500);
            assert!(page.settings_changed);
            since = page.cursor;
            pages += 1;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(pages, 3);
        assert_eq!(since, library.library_cursor().expect("latest"));
    }
}
