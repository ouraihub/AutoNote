use super::{NewNote, NotePatch, WriteOrigin, Written, derived, versions};
use crate::db::rows::{NOTE_COLUMNS, NOTE_COLUMNS_FULL, note, note_summary};
use crate::dto::{Note, NoteSummary};
use crate::error::{Entity, Error};
use crate::markdown::{count_text, derive_excerpt, normalize_link_key, sha256_hex, truncate_utf16};
use crate::types::{NoteId, Rev};
use rusqlite::{OptionalExtension, Transaction, params};

const MAX_CONTENT: usize = 2 * 1024 * 1024;
const SNAPSHOT_MS: i64 = 5 * 60 * 1000;
const SNAPSHOT_DIFF: usize = 400;

pub(super) fn title(value: Option<&str>, current: &str) -> String {
    truncate_utf16(value.unwrap_or(current).trim(), 512)
}
pub(super) fn load(tx: &Transaction<'_>, id: &str) -> Result<Option<Note>, Error> {
    let sql = format!("SELECT {NOTE_COLUMNS_FULL} FROM notes n WHERE n.id=?1");
    Ok(tx.query_row(&sql, [id], note).optional()?)
}
pub(super) fn summary(tx: &Transaction<'_>, id: &str) -> Result<NoteSummary, Error> {
    let sql = format!("SELECT {NOTE_COLUMNS} FROM notes n WHERE n.id=?1");
    Ok(tx.query_row(&sql, [id], note_summary)?)
}
pub(super) fn check_content(content: &str) -> Result<(), Error> {
    if content.len() > MAX_CONTENT {
        Err(Error::TooLarge {
            field: "content",
            limit: MAX_CONTENT as u64,
        })
    } else {
        Ok(())
    }
}

pub fn create_note(
    lib: &crate::db::Library,
    input: &NewNote,
    origin: WriteOrigin,
) -> Result<Written<Note>, Error> {
    lib.write(origin, |w| {
        if let Some(id) = &input.id {
            if let Some(existing) = load(&w.tx, id.as_str())? {
                return Ok(existing);
            }
        }
        check_content(&input.content)?;
        let id = match &input.id {
            Some(id) => id.to_string(),
            None => w.id()?,
        };
        if let Some(folder) = &input.folder_id {
            let exists: bool = w.tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 \
                 AND deleted_at IS NULL)",
                [folder.as_str()],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(Error::NotFound {
                    entity: Entity::Folder,
                    id: folder.to_string(),
                });
            }
        }
        let now = w.now.get();
        let title = title(input.title.as_deref(), "");
        let (words, chars) = count_text(&input.content);
        w.tx.execute(
            "INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,\
             char_count,is_starred,position,content_hash,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,?9,?10,?9,?9)",
            params![
                id,
                input.folder_id.as_ref().map(|x| x.as_str()),
                title,
                input.content,
                derive_excerpt(&input.content, 220),
                words as i64,
                chars as i64,
                input.is_starred,
                now,
                sha256_hex(&input.content)
            ],
        )?;
        derived::derive(
            &w.tx,
            w.ids.as_ref(),
            &id,
            &title,
            &input.content,
            false,
            w.now,
            Some(""),
        )?;
        w.record_change(&id, "upsert")?;
        let s = summary(&w.tx, &id)?;
        w.touch_note(s);
        load(&w.tx, &id)?.ok_or(Error::NotFound {
            entity: Entity::Note,
            id,
        })
    })
}

pub fn patch_note(
    lib: &crate::db::Library,
    id: &NoteId,
    patch: &NotePatch,
    origin: WriteOrigin,
) -> Result<Written<Note>, Error> {
    lib.write(origin, |w| {
        let old = match load(&w.tx, id.as_str())? {
            Some(v) => v,
            None => {
                let cursor: Option<i64> = w.tx.query_row(
                    "SELECT MAX(seq) FROM changes WHERE entity='note' \
                     AND entity_id=?1 AND op='delete'",
                    [id.as_str()],
                    |r| r.get(0),
                )?;
                return Err(Error::NoteGone {
                    deletion_cursor: cursor.map(crate::types::Cursor::new).transpose()?,
                });
            }
        };
        if patch.rev != old.summary.rev {
            return Err(Error::Conflict {
                expected: patch.rev,
                server: Box::new(old),
            });
        }
        if let Some(c) = &patch.content {
            check_content(c)?;
        }
        let new_title = title(patch.title.as_deref(), &old.summary.title);
        let new_content = patch.content.as_deref().unwrap_or(&old.content);
        let content_changed = new_content != old.content;
        let title_changed = new_title != old.summary.title;
        let folder = patch
            .folder_id
            .as_ref()
            .map(|v| v.as_ref().map(|x| x.as_str()))
            .unwrap_or(old.summary.folder_id.as_ref().map(|x| x.as_str()));
        if let Some(Some(fid)) = &patch.folder_id {
            let ok: bool = w.tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 \
                 AND deleted_at IS NULL)",
                [fid.as_str()],
                |r| r.get(0),
            )?;
            if !ok {
                return Err(Error::NotFound {
                    entity: Entity::Folder,
                    id: fid.to_string(),
                });
            }
        }
        let pinned = patch.is_pinned.unwrap_or(old.summary.is_pinned);
        let starred = patch.is_starred.unwrap_or(old.summary.is_starred);
        let archived = patch.is_archived.unwrap_or(old.summary.is_archived);
        if !content_changed
            && !title_changed
            && folder == old.summary.folder_id.as_ref().map(|x| x.as_str())
            && pinned == old.summary.is_pinned
            && starred == old.summary.is_starred
            && archived == old.summary.is_archived
        {
            return Ok(old);
        }
        let now = crate::types::Millis::new(
            w.now
                .get()
                .max(old.summary.updated_at.get().saturating_add(1)),
        )?
        .get();
        let rev = Rev::new(old.summary.rev.get() + 1)?.get();
        let (words, chars, excerpt, hash) = if content_changed {
            let (words, chars) = count_text(new_content);
            (
                words as i64,
                chars as i64,
                derive_excerpt(new_content, 220),
                sha256_hex(new_content),
            )
        } else {
            (
                old.summary.word_count as i64,
                old.summary.char_count as i64,
                old.summary.excerpt.clone(),
                sha256_hex(&old.content),
            )
        };
        if w.tx.execute(
            "UPDATE notes SET folder_id=?1,title=?2,content=?3,excerpt=?4,rev=?5,\
             word_count=?6,char_count=?7,is_pinned=?8,is_starred=?9,is_archived=?10,\
             content_hash=?11,updated_at=?12 WHERE id=?13 AND rev=?14",
            params![
                folder,
                new_title,
                new_content,
                excerpt,
                rev,
                words,
                chars,
                pinned,
                starred,
                archived,
                hash,
                now,
                id.as_str(),
                patch.rev.get()
            ],
        )? != 1
        {
            return Err(Error::Conflict {
                expected: patch.rev,
                server: Box::new(old),
            });
        }
        if content_changed && !patch.quiet && !old.content.is_empty() {
            let last: Option<i64> = w.tx.query_row(
                "SELECT MAX(created_at) FROM note_versions WHERE note_id=?1",
                [id.as_str()],
                |r| r.get(0),
            )?;
            let length_difference = new_content
                .encode_utf16()
                .count()
                .abs_diff(old.content.encode_utf16().count());
            if patch.preserve_version
                || last.is_none_or(|at| now - at > SNAPSHOT_MS)
                || length_difference >= SNAPSHOT_DIFF
            {
                let vid = w.id()?;
                versions::snapshot(
                    &w.tx,
                    id.as_str(),
                    &old.summary.title,
                    &old.content,
                    &vid,
                    crate::types::Millis::new(now)?,
                )?;
            }
        }
        let inbound = if title_changed && old.summary.deleted_at.is_none() {
            inbound_sources(&w.tx, id.as_str(), &old.summary.title, &new_title)?
        } else {
            Vec::new()
        };
        let old_key = title_changed.then(|| normalize_link_key(&old.summary.title));
        if content_changed || title_changed {
            derived::derive(
                &w.tx,
                w.ids.as_ref(),
                id.as_str(),
                &new_title,
                new_content,
                old.summary.deleted_at.is_some(),
                w.now,
                old_key.as_deref(),
            )?;
        }
        for source in inbound {
            rewrite_inbound(w, &source, &old.summary.title, &new_title)?;
        }
        w.record_change(id.as_str(), "upsert")?;
        let s = summary(&w.tx, id.as_str())?;
        w.touch_note(s);
        load(&w.tx, id.as_str())?.ok_or(Error::NotFound {
            entity: Entity::Note,
            id: id.to_string(),
        })
    })
}

fn inbound_sources(
    tx: &Transaction<'_>,
    id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<String>, Error> {
    let old_key = normalize_link_key(from);
    let new_key = normalize_link_key(to);
    let ambiguous: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM notes WHERE id<>?1 AND deleted_at IS NULL \
         AND title_key IN (?2,?3))",
        params![id, old_key, new_key],
        |r| r.get(0),
    )?;
    if ambiguous {
        return Ok(Vec::new());
    }
    let mut query = tx.prepare(
        "SELECT DISTINCT n.id FROM links l JOIN notes n ON n.id=l.source_note_id \
         WHERE l.target_note_id=?1 AND l.target_key=?2 AND n.id<>?1 \
         AND n.deleted_at IS NULL",
    )?;
    let rows = query.query_map(params![id, old_key], |r| r.get(0))?;
    let sources = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(sources)
}
fn rewrite_inbound(
    w: &mut super::WriteTx<'_>,
    source_id: &str,
    from: &str,
    to: &str,
) -> Result<(), Error> {
    let old = load(&w.tx, source_id)?.ok_or(Error::NoteGone {
        deletion_cursor: None,
    })?;
    let content = derived::rewrite_wiki_targets(&old.content, from, to);
    if content == old.content {
        return Ok(());
    }
    check_content(&content)?;
    let now = crate::types::Millis::new(
        w.now
            .get()
            .max(old.summary.updated_at.get().saturating_add(1)),
    )?
    .get();
    let rev = Rev::new(old.summary.rev.get() + 1)?.get();
    let version_id = w.id()?;
    versions::snapshot(
        &w.tx,
        source_id,
        &old.summary.title,
        &old.content,
        &version_id,
        crate::types::Millis::new(now)?,
    )?;
    let (words, chars) = count_text(&content);
    if w.tx.execute(
        "UPDATE notes SET content=?1,excerpt=?2,word_count=?3,char_count=?4,content_hash=?5,\
         rev=?6,updated_at=?7 WHERE id=?8 AND rev=?9",
        params![
            content,
            derive_excerpt(&content, 220),
            words as i64,
            chars as i64,
            sha256_hex(&content),
            rev,
            now,
            source_id,
            old.summary.rev.get()
        ],
    )? != 1
    {
        return Err(Error::Conflict {
            expected: old.summary.rev,
            server: Box::new(old),
        });
    }
    derived::derive(
        &w.tx,
        w.ids.as_ref(),
        source_id,
        &old.summary.title,
        &content,
        false,
        w.now,
        None,
    )?;
    w.record_change(source_id, "upsert")?;
    w.touch_note(summary(&w.tx, source_id)?);
    Ok(())
}
