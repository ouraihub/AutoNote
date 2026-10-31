use super::*;
#[path = "sync_batch.rs"]
mod sync_batch;
fn entity_parse(value: &str) -> rusqlite::Result<DirtyEntity> {
    match value {
        "note" => Ok(DirtyEntity::Note),
        "folder" => Ok(DirtyEntity::Folder),
        "tag" => Ok(DirtyEntity::Tag),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

/// Any local write to the row changes this token; an empty token means no live row.
fn seen(conn: &Connection, entity: DirtyEntity, id: &str) -> Result<String, Error> {
    let sql = match entity {
        DirtyEntity::Note => "SELECT 'n'||rev FROM notes WHERE id=?1",
        DirtyEntity::Folder => {
            "SELECT 'f'||updated_at FROM folders WHERE id=?1 AND deleted_at IS NULL"
        }
        DirtyEntity::Tag => {
            "SELECT 't'||name||char(1)||IFNULL(color,'') FROM tags WHERE id=?1"
        },
    };
    Ok(conn
        .query_row(sql, [id], |r| r.get(0))
        .optional()?
        .unwrap_or_default())
}

fn set_item(
    tx: &Connection,
    entity: DirtyEntity,
    id: &str,
    remote_rev: Option<i64>,
    dirty: bool,
) -> Result<(), Error> {
    tx.execute(
        "INSERT INTO sync_item(entity,id,remote_rev,dirty) VALUES(?1,?2,?3,?4) \
         ON CONFLICT(entity,id) DO UPDATE SET remote_rev=excluded.remote_rev,dirty=excluded.dirty",
    )?;
    Ok(())
}
fn is_dirty(tx: &Connection, entity: DirtyEntity, id: &str) -> Result<bool, Error> {
    Ok(tx
        .query_row(
            "SELECT dirty FROM sync_item WHERE entity=?1 AND id=?2",
            params![entity.as_str(), id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false))
}
fn forget(tx: &Connection, entity: DirtyEntity, id: &str) -> Result<(), Error> {
    tx.execute(
        "DELETE FROM sync_item WHERE entity=?1 AND id=?2",
        params![entity.as_str(), id],
    )?;
    Ok(())
}

fn load_note(tx: &Connection, id: &str) -> Result<Option<Note>, Error> {
    let sql = format!(
        "SELECT {} FROM notes n WHERE n.id=?1",
        crate::db::rows::NOTE_COLUMNS_FULL
    );
    Ok(tx.query_row(&sql, [id], crate::db::rows::note).optional()?)
}

/// Writes the remote version of a note under `id`, keeping the local rev monotonic.
fn put_note(w: &mut WriteTx<'_>, id: &str, remote: &Note) -> Result<(), Error> {
    use crate::markdown::{count_text, derive_excerpt, normalize_link_key, sha256_hex};
    if remote.content.len() > 2 * 1024 * 1024 {
        return Err(Error::TooLarge {
            field: "content",
            limit: 2 * 1024 * 1024,
        });
    }
    if remote.summary.title.encode_utf16().count() > 512 {
        return Err(Error::invalid(
            "title",
            "remote title exceeds 512 UTF-16 units",
        ));
    }
    let old = load_note(&w.tx, id)?;
    let rev = crate::types::Rev::new(
        old.as_ref().map_or(1, |o| o.summary.rev.get() + 1),
    )?
    .get();
    let s = &remote.summary;
    let (words, chars) = count_text(&remote.content);
    // A folder the local library does not have yet would orphan the note; keep it at the root.
    let folder = match &s.folder_id {
        Some(folder) => {
            w.tx.query_row(
                "SELECT id FROM folders WHERE id=?1 AND deleted_at IS NULL",
                [folder.as_str()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        }
        None => None,
    };
    w.tx.execute(
        "INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,\
         is_pinned,is_starred,is_archived,position,content_hash,created_at,updated_at,\
         deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) \
         ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,\
         content=excluded.content,excerpt=excluded.excerpt,rev=excluded.rev,\
         word_count=excluded.word_count,char_count=excluded.char_count,\
         is_pinned=excluded.is_pinned,is_starred=excluded.is_starred,\
         is_archived=excluded.is_archived,position=excluded.position,\
         content_hash=excluded.content_hash,updated_at=excluded.updated_at,\
         deleted_at=excluded.deleted_at)",
        params![
            id,
            folder,
            s.title,
            remote.content,
            derive_excerpt(&remote.content, 220),
            rev,
            words as i64,
            chars as i64,
            s.is_pinned,
            s.is_starred,
            s.is_archived,
            s.position,
            sha256_hex(&remote.content),
            s.created_at.get(),
            s.updated_at.get(),
            s.deleted_at.map(crate::types::Millis::get),
        ],
    )?;
    let old_key = old.map_or_else(String::new, |o| normalize_link_key(&o.summary.title));
    crate::write::derived::derive(
        &w.tx,
        w.ids.as_ref(),
        id,
        &s.title,
        &remote.content,
        s.deleted_at.is_some(),
        w.now,
        Some(&old_key),
    )?;
    w.record_change(id, "upsert")?;
    let summary = w.tx.query_row(
        &format!(
            "SELECT {} FROM notes n WHERE n.id=?1",
            crate::db::rows::NOTE_COLUMNS
        ),
        [id],
        crate::db::rows::note_summary,
    )?;
    w.touch_note(summary);
    Ok(())
}

fn put_folder(w: &mut WriteTx<'_>, folder: &Folder) -> Result<(), Error> {
    crate::write::folders::name(&folder.name)?;
    crate::write::folders::color(folder.color.as_deref())?;
    if !folder.position.is_finite() {
        return Err(Error::invalid(
            "position",
            "remote folder position is not finite",
        ));
    }
    let id = folder.id.as_str();
    // Missing or cyclic parents fall back to the root instead of failing the whole pull.
    let parent = folder.parent_id.as_ref().filter(|parent| {
        crate::write::folders::check_parent(&w.tx, Some(parent), Some(&folder.id)).is_ok()
    });
    // Remote wins a sibling-name clash: the local clean folder is renamed aside.
    let clash: Option<String> = w.tx.query_row(
        "SELECT id FROM folders WHERE parent_id IS ?1 AND name=?2 COLLATE NOCASE \
         AND deleted_at IS NULL AND id<>?3",
        params![parent.map(|p| p.as_str()), folder.name, id],
        |r| r.get(0),
    )
    .optional()?;
    if let Some(other) = clash {
        let renamed = format!("{} ({})", folder.name, &other[other.len() - 4..]);
        w.tx.execute(
            "UPDATE folders SET name=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
            params![renamed, w.now.get(), other],
        )?;
        record_organizer(w, "folder", &other, "upsert")?;
        mark_dirty(&w.tx, &[(DirtyEntity::Folder, other)])?;
    }
    w.tx.execute(
        "INSERT INTO folders(id,parent_id,name,icon,color,position,created_at,updated_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET \
         parent_id=excluded.parent_id,name=excluded.name,icon=excluded.icon,\
         color=excluded.color,position=excluded.position,\
         updated_at=MAX(folders.updated_at+1,excluded.updated_at),deleted_at=NULL",
        params![
            id,
            parent.map(|p| p.as_str()),
            folder.name,
            folder.icon.as_deref().map(|v| crate::markdown::truncate_utf16(v, 8)),
            folder.color,
            folder.position,
            folder.created_at.get(),
            folder.updated_at.get(),
        ],
    )?;
    record_organizer(w, "folder", id, "upsert")
}

/// Remote tags are manual tags. A local tag with the same name but a different
/// id is merged into the remote id, so name-unique tags converge.
fn put_tag(w: &mut WriteTx<'_>, tag: &Tag) -> Result<(), Error> {
    let id = tag.id.as_str();
    let name = tag.name.trim();
    if name.is_empty() || name.encode_utf16().count() > 60 || name.contains(char::is_whitespace) {
        return Err(Error::invalid("name", "invalid remote tag name"));
    }
    let local: Option<String> =
        w.tx.query_row(
            "SELECT id FROM tags WHERE name=?1 COLLATE NOCASE AND id<>?2",
            params![name, id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(local) = local {
        w.tx.execute("INSERT OR IGNORE INTO note_tags(note_id,tag_id) SELECT note_id,?1 FROM note_tags WHERE tag_id=?2", params![id, local])?;
        w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [&local])?;
        w.tx.execute("DELETE FROM tags WHERE id=?1", [&local])?;
        forget(&w.tx, DirtyEntity::Tag, &local)?;
        record_organizer(w, "tag", &local, "delete")?;
    }
    w.tx.execute(
        "INSERT INTO tags(id,name,color,is_manual,created_at) VALUES(?1,?2,?3,1,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,is_manual=1",
        params![id, name, tag.color, tag.created_at.get()],
    )?;
    record_organizer(w, "tag", id, "upsert")
}

fn record_organizer(w: &mut WriteTx<'_>, entity: &str, id: &str, op: &str) -> Result<(), Error> {
    w.tx.execute(
        "INSERT INTO changes(entity,entity_id,op,at) VALUES(?1,?2,?3,?4)",
        params![entity, id, op, w.now.get()],
    )?;
    let kind = if entity == "folder" {
        DirtyEntity::Folder
    } else {
        DirtyEntity::Tag
    };
    w.mark(kind, id);
    Ok(())
}

/// Whether the remote version carries the same user-visible state as the local note.
fn same_note(local: &Note, remote: &Note) -> bool {
    let (a, b) = (&local.summary, &remote.summary);
    local.content == remote.content
        && a.title == b.title
        && a.folder_id == b.folder_id
        && a.is_pinned == b.is_pinned
        && a.is_starred == b.is_starred
        && a.is_archived == b.is_archived
        && a.deleted_at.is_some() == b.deleted_at.is_some()
}

fn conflict_title(title: &str, now: crate::types::Millis) -> String {
    // UTC keeps the stamp independent of the host's timezone database.
    let stamp = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(now.get()) * 1_000_000)
        .ok()
        .and_then(|date| {
            date.format(time::macros::format_description!(
                "[year]-[month]-[day] [hour]:[minute]"
            ))
            .ok()
        })
        .unwrap_or_default();
    let suffix = format!("（冲突 {stamp}）");
    let base = crate::markdown::truncate_utf16(title, 512 - suffix.encode_utf16().count());
    format!("{base}{suffix}")
}

/// Saves the local version under a new id as a pending note; returns that id.
fn fork_copy(w: &mut WriteTx<'_>, local: &Note) -> Result<String, Error> {
    use crate::markdown::{count_text, derive_excerpt, sha256_hex};
    let id = w.id()?;
    let s = &local.summary;
    let title = conflict_title(&s.title, w.now);
    let (words, chars) = count_text(&local.content);
    w.tx.execute(
        "INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,is_pinned,is_starred,is_archived,position,content_hash,created_at,updated_at,deleted_at) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,?9,?10,?11,?12,?13,?13,?14)",
        params![id, s.folder_id.as_ref().map(|f| f.as_str()), title, local.content, derive_excerpt(&local.content, 220), words as i64, chars as i64, s.is_pinned, s.is_starred, s.is_archived, s.position, sha256_hex(&local.content), w.now.get(), s.deleted_at.map(crate::types::Millis::get)],
    )?;
    crate::write::derived::derive(
        &w.tx,
        w.ids.as_ref(),
        &id,
        &title,
        &local.content,
        s.deleted_at.is_some(),
        w.now,
        Some(""),
    )?;
    w.record_change(&id, "upsert")?;
    let summary = w.tx.query_row(
        &format!(
            "SELECT {} FROM notes n WHERE n.id=?1",
            crate::db::rows::NOTE_COLUMNS
        ),
        [id.as_str()],
        crate::db::rows::note_summary,
    )?;
    w.touch_note(summary);
    set_item(&w.tx, DirtyEntity::Note, &id, None, true)?;
    Ok(id)
}

/// Folder depth by id over every row, including soft-deleted ones.
fn folder_depths(conn: &Connection) -> Result<HashMap<String, usize>, Error> {
    let mut stmt = conn.prepare("SELECT id,parent_id FROM folders")?;
    let parents: HashMap<String, Option<String>> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut depths = HashMap::with_capacity(parents.len());
    for id in parents.keys() {
        let mut depth = 0;
        let mut current = parents.get(id).cloned().flatten();
        while let Some(parent) = current {
            depth += 1;
            if depth > 12 {
                break;
            }
            current = parents.get(&parent).cloned().flatten();
        }
        depths.insert(id.clone(), depth);
    }
    Ok(depths)
}


