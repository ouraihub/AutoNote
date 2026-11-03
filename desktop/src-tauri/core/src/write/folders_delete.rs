use super::{FolderDeleteResult, FolderDeleteStrategy, check_name, load, record};
use crate::db::rows::{NOTE_COLUMNS, note_summary};
use crate::error::Error;
use crate::types::{FolderId, Rev};
use crate::write::{WriteOrigin, Written};
use rusqlite::params;

impl crate::db::Library {
    /// Removes a folder by promoting its children or soft-deleting its entire subtree.
    /// # Errors
    /// Rejects missing folders, promotion collisions and database failures atomically.
    pub fn remove_folder(
        &self,
        id: &FolderId,
        strategy: FolderDeleteStrategy,
        origin: WriteOrigin,
    ) -> Result<Written<FolderDeleteResult>, Error> {
        self.write(origin, |w| {
            let old = load(&w.tx, id.as_str())?;
            let mut folders = Vec::new();
            match strategy {
                FolderDeleteStrategy::MoveUp => {
                    let mut stmt = w.tx.prepare(
                        "SELECT id,name FROM folders WHERE parent_id=?1 \
                         AND deleted_at IS NULL ORDER BY position,id",
                    )?;
                    let children = stmt
                        .query_map([id.as_str()], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(stmt);
                    for (_, child_name) in &children {
                        check_name(&w.tx, old.parent_id.as_ref(), child_name, Some(id.as_str()))?;
                    }
                    for (child, _) in &children {
                        w.tx.execute(
                            "UPDATE folders SET parent_id=?1,\
                             updated_at=MAX(updated_at+1,?2) WHERE id=?3",
                            params![
                                old.parent_id.as_ref().map(FolderId::as_str),
                                w.now.get(),
                                child,
                            ],
                        )?;
                        record(w, child, "upsert")?;
                    }
                    folders.push(id.to_string());
                }
                FolderDeleteStrategy::Delete => {
                    let mut stmt = w.tx.prepare(
                        "WITH RECURSIVE tree(id,depth) AS (\
                         SELECT id,1 FROM folders WHERE id=?1 AND deleted_at IS NULL \
                         UNION ALL SELECT f.id,t.depth+1 FROM folders f JOIN tree t \
                         ON f.parent_id=t.id WHERE f.deleted_at IS NULL AND t.depth<=12) \
                         SELECT id FROM tree",
                    )?;
                    folders = stmt
                        .query_map([id.as_str()], |r| r.get(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                }
            }
            let note_ids = {
                let mut stmt = w.tx.prepare(match strategy {
                    FolderDeleteStrategy::MoveUp => "SELECT id FROM notes WHERE folder_id=?1",
                    FolderDeleteStrategy::Delete => {
                        "WITH RECURSIVE tree(id,depth) AS (\
                     SELECT id,1 FROM folders WHERE id=?1 UNION ALL \
                     SELECT f.id,t.depth+1 FROM folders f JOIN tree t ON f.parent_id=t.id \
                     WHERE f.deleted_at IS NULL AND t.depth<=12) \
                     SELECT id FROM notes WHERE folder_id IN (SELECT id FROM tree)"
                    }
                })?;
                let rows = stmt.query_map([id.as_str()], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for note_id in &note_ids {
                let (title, content, current_rev, updated): (String, String, i64, i64) =
                    w.tx.query_row(
                        "SELECT title,content,rev,updated_at FROM notes WHERE id=?1",
                        [note_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )?;
                let now = w.now.get().max(updated.saturating_add(1));
                Rev::new(current_rev + 1)?;
                if strategy == FolderDeleteStrategy::Delete {
                    w.tx.execute(
                        "UPDATE notes SET folder_id=NULL,deleted_at=COALESCE(?1,deleted_at),\
                         rev=rev+1,updated_at=?1 WHERE id=?2",
                        params![now, note_id],
                    )?;
                    crate::write::derived::derive(
                        &w.tx,
                        w.ids.as_ref(),
                        note_id,
                        &title,
                        &content,
                        true,
                        w.now,
                        Some(&crate::markdown::normalize_link_key(&title)),
                    )?;
                } else {
                    w.tx.execute(
                        "UPDATE notes SET folder_id=?1,rev=rev+1,updated_at=?2 WHERE id=?3",
                        params![old.parent_id.as_ref().map(FolderId::as_str), now, note_id],
                    )?;
                }
                w.record_change(note_id, "upsert")?;
                let sql = format!("SELECT {NOTE_COLUMNS} FROM notes n WHERE n.id=?1");
                w.touch_note(w.tx.query_row(&sql, [note_id], note_summary)?);
            }
            if strategy == FolderDeleteStrategy::Delete {
                w.tx.execute(
                    "UPDATE links SET target_note_id=(SELECT n.id FROM notes n \
                     WHERE n.title_key=links.target_key AND n.deleted_at IS NULL \
                     ORDER BY n.created_at,n.id LIMIT 1) \
                     WHERE target_note_id IN (SELECT id FROM notes WHERE deleted_at IS NOT NULL)",
                    [],
                )?;
            }
            for folder_id in &folders {
                w.tx.execute(
                    "UPDATE folders SET deleted_at=?1,\
                     updated_at=MAX(updated_at+1,?1) WHERE id=?2",
                    params![w.now.get(), folder_id],
                )?;
                record(w, folder_id, "delete")?;
                w.delete(folder_id.clone());
            }
            Ok(FolderDeleteResult {
                folders: folders.len() as u64,
                notes: note_ids.len() as u64,
            })
        })
    }
}
