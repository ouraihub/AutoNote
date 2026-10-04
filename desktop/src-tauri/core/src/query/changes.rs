//! Local change feed: `notes_snapshot` and the host-internal `library_changes`.
//!
//! Both read under one connection lock, so the returned cursor and rows are a
//! single consistent view. The cursor is `changes.seq`, never a remote cursor.
use rusqlite::{Connection, OptionalExtension};

use crate::db::Library;
use crate::db::rows::{FOLDER_COLUMNS, NOTE_COLUMNS, TAG_COLUMNS, folder, note_summary, tag};
use crate::dto::{DeletedEntity, Folder, NoteSummary, SyncDeletion, SyncResponse, Tag};
use crate::error::Error;
use crate::types::Cursor;

fn cursor(conn: &Connection) -> Result<Cursor, Error> {
    let seq: Option<i64> = conn.query_row("SELECT MAX(seq) FROM changes", [], |r| r.get(0))?;
    Cursor::new(seq.unwrap_or(0))
}

/// Folders and tags are small and rev-less; every response carries the full
/// live set (`facetsFull`), so removals need no separate tombstone.
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

fn notes(conn: &Connection, since: Option<i64>) -> Result<Vec<NoteSummary>, Error> {
    let sql = match since {
        None => format!("SELECT {NOTE_COLUMNS} FROM notes n ORDER BY n.updated_at DESC, n.id"),
        Some(_) => format!(
            "SELECT {NOTE_COLUMNS} FROM notes n WHERE n.id IN \
             (SELECT entity_id FROM changes WHERE seq > ?1 AND entity='note' AND op='upsert') \
             ORDER BY n.updated_at DESC, n.id"
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows: rusqlite::Result<Vec<_>> = match since {
        None => stmt.query_map([], note_summary)?.collect(),
        Some(since) => stmt.query_map([since], note_summary)?.collect(),
    };
    Ok(rows?)
}

/// Notes purged after `since`, unless re-created later in the same window.
fn deletions(conn: &Connection, since: i64) -> Result<Vec<SyncDeletion>, Error> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT c.entity_id FROM changes c WHERE c.seq > ?1 AND c.entity='note' AND c.op='delete' \
         AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = c.entity_id) ORDER BY c.entity_id",
    )?;
    let ids = stmt.query_map([since], |r| r.get::<_, String>(0))?;
    ids.map(|id| {
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
            let cursor = cursor(conn)?;
            let since = match since {
                Some(since) if !stale(conn, since, cursor.get())? => Some(since),
                _ => None,
            };
            let (folders, tags) = facets(conn)?;
            let settings_changed = match since {
                // AutoNote `fullSnapshot` reports every facet as changed.
                None => true,
                Some(since) => conn
                    .query_row(
                        "SELECT 1 FROM changes WHERE seq > ?1 AND entity='settings' LIMIT 1",
                        [since],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some(),
            };
            Ok(SyncResponse {
                cursor,
                full: since.is_none(),
                has_more: false,
                next_key: None,
                facets_full: true,
                settings_changed,
                profile_changed: None,
                site_changed: None,
                notes: notes(conn, since)?,
                folders,
                tags,
                deletions: since.map_or(Ok(Vec::new()), |since| deletions(conn, since))?,
                server_time,
            })
        })
    }

    /// The complete local summary view (`notes.snapshot`): `full=true`, no bodies.
    ///
    /// # Errors
    /// Returns SQLite or row-decoding errors.
    pub fn notes_snapshot(&self) -> Result<SyncResponse, Error> {
        self.sync_response(None)
    }

    /// Current local change-feed position.
    ///
    /// # Errors
    /// Returns SQLite errors.
    pub fn library_cursor(&self) -> Result<Cursor, Error> {
        self.read(cursor)
    }

    /// Changes after the local cursor `since`. A cursor older than the retained
    /// feed, or ahead of it, yields the full snapshot instead of a silent gap.
    ///
    /// # Errors
    /// Returns SQLite or row-decoding errors.
    pub fn library_changes(&self, since: Cursor) -> Result<SyncResponse, Error> {
        self.sync_response(Some(since.get()))
    }
}

/// Mirrors AutoNote `sync.ts` `needFull`: `since<=0` or older than the
/// retained feed. Desktop also resets a cursor ahead of `hi`: locally that
/// means a different library file, not trimmed server data.
fn stale(conn: &Connection, since: i64, latest: i64) -> Result<bool, Error> {
    if since <= 0 || since > latest {
        return Ok(true);
    }
    let oldest: Option<i64> = conn.query_row("SELECT MIN(seq) FROM changes", [], |r| r.get(0))?;
    Ok(oldest.is_some_and(|oldest| since < oldest - 1))
}
