use super::notes::{check_content, load, summary, title};
use super::{WriteOrigin, Written, derived, versions};
use crate::dto::Note;
use crate::error::{Entity, Error};
use crate::markdown::{count_text, derive_excerpt, normalize_link_key, sha256_hex, truncate_utf16};
use crate::types::{NoteId, Rev, VersionId};
use rusqlite::{OptionalExtension, params};

/// Mirrors Web `DELETE /notes/:id`: already-trashed is not_found; returns the full note.
pub(crate) fn trash_note(
    lib: &crate::db::Library,
    id: &NoteId,
    origin: WriteOrigin,
) -> Result<Written<Note>, Error> {
    lib.write(origin, |w| {
        let old = load(&w.tx, id.as_str())?.ok_or(Error::NoteGone {
            deletion_cursor: None,
        })?;
        if old.summary.deleted_at.is_some() {
            return Err(Error::NotFound {
                entity: Entity::Note,
                id: id.to_string(),
            });
        }
        let now = crate::types::Millis::new(
            w.now
                .get()
                .max(old.summary.updated_at.get().saturating_add(1)),
        )?
        .get();
        Rev::new(old.summary.rev.get() + 1)?;
        w.tx.execute(
            "UPDATE notes SET deleted_at=?1,rev=rev+1,updated_at=?1 WHERE id=?2 AND rev=?3",
            params![now, id.as_str(), old.summary.rev.get()],
        )?;
        derived::derive(
            &w.tx,
            w.ids.as_ref(),
            id.as_str(),
            &old.summary.title,
            &old.content,
            true,
            w.now,
            Some(&normalize_link_key(&old.summary.title)),
        )?;
        w.record_change(id.as_str(), "upsert")?;
        w.touch_note(summary(&w.tx, id.as_str())?);
        load(&w.tx, id.as_str())?.ok_or(Error::NotFound {
            entity: Entity::Note,
            id: id.to_string(),
        })
    })
}

/// Mirrors Web `POST /notes/:id/restore`: a live note is bad_request.
pub(crate) fn restore_note(
    lib: &crate::db::Library,
    id: &NoteId,
    origin: WriteOrigin,
) -> Result<Written<Note>, Error> {
    lib.write(origin, |w| {
        let old = load(&w.tx, id.as_str())?.ok_or(Error::NoteGone {
            deletion_cursor: None,
        })?;
        if old.summary.deleted_at.is_none() {
            return Err(Error::invalid("id", "The note is not in the trash"));
        }
        let now = crate::types::Millis::new(
            w.now
                .get()
                .max(old.summary.updated_at.get().saturating_add(1)),
        )?
        .get();
        Rev::new(old.summary.rev.get() + 1)?;
        w.tx.execute(
            "UPDATE notes SET deleted_at=NULL,rev=rev+1,updated_at=?1 \
             WHERE id=?2 AND rev=?3 AND deleted_at IS NOT NULL",
            params![now, id.as_str(), old.summary.rev.get()],
        )?;
        derived::derive(
            &w.tx,
            w.ids.as_ref(),
            id.as_str(),
            &old.summary.title,
            &old.content,
            false,
            w.now,
            Some(&normalize_link_key(&old.summary.title)),
        )?;
        w.record_change(id.as_str(), "upsert")?;
        w.touch_note(summary(&w.tx, id.as_str())?);
        load(&w.tx, id.as_str())?.ok_or(Error::NotFound {
            entity: Entity::Note,
            id: id.to_string(),
        })
    })
}

/// Mirrors Web `DELETE /notes/:id/purge`: only trashed notes; returns the deletion cursor.
pub(crate) fn purge_note(
    lib: &crate::db::Library,
    id: &NoteId,
    origin: WriteOrigin,
) -> Result<Written<crate::types::Cursor>, Error> {
    lib.write(origin, |w| {
        let note = load(&w.tx, id.as_str())?.ok_or(Error::NoteGone {
            deletion_cursor: None,
        })?;
        if note.summary.deleted_at.is_none() {
            return Err(Error::NotFound {
                entity: Entity::Note,
                id: id.to_string(),
            });
        }
        purge_tx(w, id.as_str())?;
        crate::types::Cursor::new(w.tx.last_insert_rowid())
    })
}

pub(crate) fn restore_version(
    lib: &crate::db::Library,
    id: &NoteId,
    version: &VersionId,
    rev: Rev,
    origin: WriteOrigin,
) -> Result<Written<Note>, Error> {
    lib.write(origin, |w| {
        let old = load(&w.tx, id.as_str())?.ok_or(Error::NoteGone {
            deletion_cursor: None,
        })?;
        if rev != old.summary.rev {
            return Err(Error::Conflict {
                expected: rev,
                server: Box::new(old),
            });
        }
        let snapshot: Option<(String, String)> =
            w.tx.query_row(
                "SELECT title,content FROM note_versions WHERE id=?1 AND note_id=?2",
                params![version.as_str(), id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (new_title, new_content) = snapshot.ok_or(Error::NotFound {
            entity: Entity::Version,
            id: version.to_string(),
        })?;
        let new_title = title(Some(&new_title), "");
        check_content(&new_content)?;
        if new_title == old.summary.title && new_content == old.content {
            return Ok(old);
        }
        let now = crate::types::Millis::new(
            w.now
                .get()
                .max(old.summary.updated_at.get().saturating_add(1)),
        )?
        .get();
        let snapshot_id = w.id()?;
        versions::snapshot(
            &w.tx,
            id.as_str(),
            &old.summary.title,
            &old.content,
            &snapshot_id,
            crate::types::Millis::new(now)?,
        )?;
        let (words, chars) = count_text(&new_content);
        if w.tx.execute(
            "UPDATE notes SET title=?1,content=?2,excerpt=?3,word_count=?4,char_count=?5,\
             content_hash=?6,rev=?7,updated_at=?8 WHERE id=?9 AND rev=?10",
            params![
                new_title,
                new_content,
                derive_excerpt(&new_content, 220),
                words as i64,
                chars as i64,
                sha256_hex(&new_content),
                Rev::new(rev.get() + 1)?.get(),
                now,
                id.as_str(),
                rev.get()
            ],
        )? != 1
        {
            return Err(Error::Conflict {
                expected: rev,
                server: Box::new(old),
            });
        }
        derived::derive(
            &w.tx,
            w.ids.as_ref(),
            id.as_str(),
            &new_title,
            &new_content,
            old.summary.deleted_at.is_some(),
            w.now,
            Some(&normalize_link_key(&old.summary.title)),
        )?;
        w.record_change(id.as_str(), "upsert")?;
        w.touch_note(summary(&w.tx, id.as_str())?);
        load(&w.tx, id.as_str())?.ok_or(Error::NotFound {
            entity: Entity::Note,
            id: id.to_string(),
        })
    })
}

/// Mirrors Web `POST /notes/:id/duplicate`: an existing `copy_id` is returned as-is.
pub(crate) fn duplicate_note(
    lib: &crate::db::Library,
    id: &NoteId,
    copy_id: Option<&NoteId>,
    origin: WriteOrigin,
) -> Result<Written<Note>, Error> {
    lib.write(origin, |w| {
        let source = load(&w.tx, id.as_str())?.ok_or(Error::NoteGone {
            deletion_cursor: None,
        })?;
        if let Some(copy_id) = copy_id {
            if let Some(existing) = load(&w.tx, copy_id.as_str())? {
                return Ok(existing);
            }
        }
        let new_id = match copy_id {
            Some(copy_id) => copy_id.to_string(),
            None => w.id()?,
        };
        // shared `duplicateNoteTitle(title, 512)`: fallback 'Untitled note', suffix ' copy'.
        let base = source.summary.title.trim();
        let name = format!(
            "{} copy",
            truncate_utf16(
                if base.is_empty() {
                    "Untitled note"
                } else {
                    base
                },
                507,
            )
        );
        let (words, chars) = count_text(&source.content);
        let now = w.now.get();
        w.tx.execute(
            "INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,\
             is_archived,position,content_hash,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,?9,?10,?9,?9)",
            params![
                new_id,
                source.summary.folder_id.as_ref().map(|v| v.as_str()),
                name,
                source.content,
                derive_excerpt(&source.content, 220),
                words as i64,
                chars as i64,
                source.summary.is_archived,
                now,
                sha256_hex(&source.content)
            ],
        )?;
        derived::derive(
            &w.tx,
            w.ids.as_ref(),
            &new_id,
            &name,
            &source.content,
            false,
            w.now,
            Some(""),
        )?;
        w.record_change(&new_id, "upsert")?;
        w.touch_note(summary(&w.tx, &new_id)?);
        load(&w.tx, &new_id)?.ok_or(Error::NotFound {
            entity: Entity::Note,
            id: new_id,
        })
    })
}

pub(crate) fn empty_trash(
    lib: &crate::db::Library,
    origin: WriteOrigin,
) -> Result<Written<u64>, Error> {
    lib.write(origin, |w| {
        let ids: Vec<String> = {
            let mut query =
                w.tx.prepare("SELECT id FROM notes WHERE deleted_at IS NOT NULL")?;
            let rows = query.query_map([], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in &ids {
            purge_tx(w, id)?;
        }
        Ok(ids.len() as u64)
    })
}

pub(crate) fn purge_tx(w: &mut super::WriteTx<'_>, id: &str) -> Result<(), Error> {
    w.tx.execute("DELETE FROM note_versions WHERE note_id=?1", [id])?;
    w.tx.execute("DELETE FROM note_tags WHERE note_id=?1", [id])?;
    w.tx.execute("DELETE FROM links WHERE source_note_id=?1", [id])?;
    w.tx.execute(
        "UPDATE links SET target_note_id=(SELECT n.id FROM notes n \
         WHERE n.title_key=links.target_key AND n.id<>?1 AND n.deleted_at IS NULL \
         ORDER BY n.created_at,n.id LIMIT 1) WHERE target_note_id=?1",
        [id],
    )?;
    w.tx.execute("DELETE FROM notes_fts WHERE note_id=?1", [id])?;
    w.tx.execute("UPDATE attachments SET note_id=NULL WHERE note_id=?1", [id])?;
    w.tx.execute("DELETE FROM notes WHERE id=?1", [id])?;
    w.tx.execute(
        "DELETE FROM tags WHERE is_manual=0 AND id NOT IN (SELECT tag_id FROM note_tags)",
        [],
    )?;
    w.tx.execute(
        "INSERT INTO changes(entity,entity_id,op,at) VALUES('note',?1,'delete',?2)",
        params![id, w.now.get()],
    )?;
    w.mark(super::DirtyEntity::Note, id);
    w.delete(id.to_owned());
    Ok(())
}
