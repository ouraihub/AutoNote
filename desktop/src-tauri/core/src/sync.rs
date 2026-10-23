//! Desktop sync state (22 §6): one binding, a dirty flag and confirmed remote
//! rev per row, and attachment id maps. Network code stays in note-sync; every
//! method is one short transaction and never hands out the connection.
use crate::dto::{DeletedEntity, Folder, Note, SyncDeletion, Tag};
use crate::error::Error;
use crate::write::{DirtyEntity, WriteOrigin, WriteTx};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// The single remote account this library syncs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub site_origin: String,
    pub account_hint: String,
    pub remote_user_id: String,
}
/// Encrypted session cookie metadata; the plaintext never reaches note-core.
#[derive(Clone, PartialEq, Eq)]
pub struct SyncCookie {
    pub ciphertext: Vec<u8>,
    pub name: String,
    pub domain: String,
    pub path: String,
    pub expires_at: Option<i64>,
    pub secure: bool,
    pub host_only: bool,
    pub same_site: String,
}
/// The stored binding row.
#[derive(Clone, PartialEq, Eq)]
pub struct BindingState {
    pub binding: Binding,
    pub cookie: SyncCookie,
    /// Last remote change sequence applied in full.
    pub cursor: i64,
    pub last_success_at: Option<i64>,
    pub last_error_code: Option<String>,
}
/// Remote rows applied in one transaction. Note bodies must already reference
/// local attachment ids.
#[derive(Debug, Clone, Default)]
pub struct RemoteBatch {
    pub cursor: i64,
    /// A full snapshot: confirmed local rows absent from it were deleted remotely.
    pub full: bool,
    pub notes: Vec<Note>,
    pub folders: Vec<Folder>,
    pub tags: Vec<Tag>,
    pub deletions: Vec<SyncDeletion>,
}
/// How a remote snapshot compares with local notes, matched by id only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCounts {
    pub local_only: u64,
    pub remote_only: u64,
    pub same: u64,
    pub different: u64,
}
/// Current local state of a dirty row.
#[derive(Debug, Clone)]
pub enum LocalRow {
    Note(Note),
    Folder(Folder),
    Tag(Tag),
    /// Purged note, deleted folder or deleted tag.
    Missing,
}
/// One row awaiting push, in the order of 22 §7.3.
#[derive(Debug, Clone)]
pub struct DirtyItem {
    pub entity: DirtyEntity,
    pub id: String,
    /// Last confirmed remote note rev; `None` means the remote never had it.
    pub remote_rev: Option<i64>,
    pub row: LocalRow,
    /// Local state token: `sync_settle` clears `dirty` only if it is unchanged.
    pub seen: String,
}

/// Registers rows touched by a local write; called once from `Library::write`.
pub(crate) fn mark_dirty(
    tx: &Transaction<'_>,
    touched: &[(DirtyEntity, String)],
) -> Result<(), Error> {
    if touched.is_empty() {
        return Ok(());
    }
    let mut stmt = tx.prepare_cached(
        "INSERT INTO sync_item(entity,id,dirty) VALUES(?1,?2,1) ON CONFLICT(entity,id) DO UPDATE SET dirty=1",
    )?;
    for (entity, id) in touched {
        stmt.execute(params![entity.as_str(), id])?;
    }
    Ok(())
}

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
        DirtyEntity::Tag => "SELECT 't'||name||char(1)||IFNULL(color,'') FROM tags WHERE id=?1",
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
        "INSERT INTO sync_item(entity,id,remote_rev,dirty) VALUES(?1,?2,?3,?4) ON CONFLICT(entity,id) DO UPDATE SET remote_rev=excluded.remote_rev,dirty=excluded.dirty",
        params![entity.as_str(), id, remote_rev, dirty],
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
    let rev = crate::types::Rev::new(old.as_ref().map_or(1, |o| o.summary.rev.get() + 1))?.get();
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
        "INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,is_pinned,is_starred,is_archived,position,content_hash,created_at,updated_at,deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,content=excluded.content,excerpt=excluded.excerpt,rev=excluded.rev,word_count=excluded.word_count,char_count=excluded.char_count,is_pinned=excluded.is_pinned,is_starred=excluded.is_starred,is_archived=excluded.is_archived,position=excluded.position,content_hash=excluded.content_hash,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at",
        params![id, folder, s.title, remote.content, derive_excerpt(&remote.content, 220), rev, words as i64, chars as i64, s.is_pinned, s.is_starred, s.is_archived, s.position, sha256_hex(&remote.content), s.created_at.get(), s.updated_at.get(), s.deleted_at.map(crate::types::Millis::get)],
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
        "SELECT id FROM folders WHERE parent_id IS ?1 AND name=?2 COLLATE NOCASE AND deleted_at IS NULL AND id<>?3",
        params![parent.map(|p| p.as_str()), folder.name, id],
        |r| r.get(0),
    ).optional()?;
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
        "INSERT INTO folders(id,parent_id,name,icon,color,position,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,icon=excluded.icon,color=excluded.color,position=excluded.position,updated_at=MAX(folders.updated_at+1,excluded.updated_at),deleted_at=NULL",
        params![id, parent.map(|p| p.as_str()), folder.name, folder.icon.as_deref().map(|v| crate::markdown::truncate_utf16(v, 8)), folder.color, folder.position, folder.created_at.get(), folder.updated_at.get()],
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

/// Remote folders ordered so every parent present in the batch precedes its children.
fn parents_first(folders: &[Folder]) -> Vec<&Folder> {
    let mut pending: Vec<&Folder> = folders.iter().collect();
    let mut ordered = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let before = pending.len();
        let ids: HashSet<&str> = pending.iter().copied().map(|f| f.id.as_str()).collect();
        pending.retain(|folder| {
            let ready = folder
                .parent_id
                .as_ref()
                .is_none_or(|parent| !ids.contains(parent.as_str()));
            if ready {
                ordered.push(*folder);
            }
            !ready
        });
        if pending.len() == before {
            // A remote cycle: put_folder drops the invalid parent.
            ordered.append(&mut pending);
        }
    }
    ordered
}

fn entity_of(entity: &DeletedEntity) -> DirtyEntity {
    match entity {
        DeletedEntity::Note => DirtyEntity::Note,
        DeletedEntity::Folder => DirtyEntity::Folder,
        DeletedEntity::Tag => DirtyEntity::Tag,
    }
}

/// Applies a remote deletion to a clean local row (22 §7.2): live notes and
/// folders go to the trash, a note already in the trash is purged, tags go.
fn delete_local(w: &mut WriteTx<'_>, entity: DirtyEntity, id: &str) -> Result<(), Error> {
    match entity {
        DirtyEntity::Note => {
            let Some(note) = load_note(&w.tx, id)? else {
                return Ok(());
            };
            if note.summary.deleted_at.is_some() {
                crate::write::notes::purge_tx(w, id)?;
            } else {
                let mut trashed = note.clone();
                trashed.summary.deleted_at = Some(w.now);
                trashed.summary.updated_at =
                    crate::types::Millis::new(w.now.get().max(note.summary.updated_at.get() + 1))?;
                put_note(w, id, &trashed)?;
            }
        }
        DirtyEntity::Folder => {
            let parent: Option<Option<String>> =
                w.tx.query_row(
                    "SELECT parent_id FROM folders WHERE id=?1 AND deleted_at IS NULL",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(parent) = parent else {
                return Ok(());
            };
            // Contents the remote did not already move go up a level, as `strategy=move-up` does.
            let notes: Vec<String> = {
                let mut stmt = w.tx.prepare("SELECT id FROM notes WHERE folder_id=?1")?;
                stmt.query_map([id], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            for note in &notes {
                w.tx.execute(
                    "UPDATE notes SET folder_id=?1,rev=rev+1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
                    params![parent, w.now.get(), note],
                )?;
                w.record_change(note, "upsert")?;
            }
            let children: Vec<String> = {
                let mut stmt = w
                    .tx
                    .prepare("SELECT id FROM folders WHERE parent_id=?1 AND deleted_at IS NULL")?;
                stmt.query_map([id], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            for child in &children {
                w.tx.execute(
                    "UPDATE folders SET parent_id=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
                    params![parent, w.now.get(), child],
                )?;
                record_organizer(w, "folder", child, "upsert")?;
            }
            w.tx.execute(
                "UPDATE folders SET deleted_at=?1,updated_at=MAX(updated_at+1,?1) WHERE id=?2",
                params![w.now.get(), id],
            )?;
            record_organizer(w, "folder", id, "delete")?;
            w.delete(id.to_owned());
        }
        DirtyEntity::Tag => {
            if w.tx.execute("DELETE FROM tags WHERE id=?1", [id])? > 0 {
                w.tx.execute("DELETE FROM note_tags WHERE tag_id=?1", [id])?;
                record_organizer(w, "tag", id, "delete")?;
            }
        }
    }
    forget(&w.tx, entity, id)
}

/// 22 §7.2 step 3 in the caller's transaction. With `bind`, a differing dirty
/// note is first saved as a conflict copy and organizers take the remote version (§6.4).
fn apply_batch(w: &mut WriteTx<'_>, batch: &RemoteBatch, bind: bool) -> Result<(), Error> {
    for folder in parents_first(&batch.folders) {
        if bind || !is_dirty(&w.tx, DirtyEntity::Folder, folder.id.as_str())? {
            put_folder(w, folder)?;
            set_item(&w.tx, DirtyEntity::Folder, folder.id.as_str(), None, false)?;
        }
    }
    for tag in &batch.tags {
        if bind || !is_dirty(&w.tx, DirtyEntity::Tag, tag.id.as_str())? {
            put_tag(w, tag)?;
            set_item(&w.tx, DirtyEntity::Tag, tag.id.as_str(), None, false)?;
        }
    }
    for remote in &batch.notes {
        let id = remote.summary.id.as_str();
        let dirty = is_dirty(&w.tx, DirtyEntity::Note, id)?;
        // Pull keeps a dirty note; its push gets 409 and resolves there (§7.3).
        if dirty && !bind {
            continue;
        }
        match load_note(&w.tx, id)? {
            Some(local) if same_note(&local, remote) => {}
            Some(local) if dirty => {
                fork_copy(w, &local)?;
                put_note(w, id, remote)?;
            }
            _ => put_note(w, id, remote)?,
        }
        set_item(
            &w.tx,
            DirtyEntity::Note,
            id,
            Some(remote.summary.rev.get()),
            false,
        )?;
    }
    let mut gone: Vec<(DirtyEntity, String)> = batch
        .deletions
        .iter()
        .map(|d| (entity_of(&d.entity), d.id.clone()))
        .collect();
    if batch.full {
        // Rows the remote once confirmed (clean items) but no longer has.
        let present: HashSet<(DirtyEntity, &str)> = batch
            .notes
            .iter()
            .map(|n| (DirtyEntity::Note, n.summary.id.as_str()))
            .chain(
                batch
                    .folders
                    .iter()
                    .map(|f| (DirtyEntity::Folder, f.id.as_str())),
            )
            .chain(batch.tags.iter().map(|t| (DirtyEntity::Tag, t.id.as_str())))
            .collect();
        let mut stmt =
            w.tx.prepare("SELECT entity,id FROM sync_item WHERE dirty=0")?;
        let clean = stmt
            .query_map([], |r| {
                Ok((
                    entity_parse(&r.get::<_, String>(0)?)?,
                    r.get::<_, String>(1)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        gone.extend(
            clean
                .into_iter()
                .filter(|(entity, id)| !present.contains(&(*entity, id.as_str()))),
        );
    }
    for (entity, id) in gone {
        if !is_dirty(&w.tx, entity, &id)? {
            delete_local(w, entity, &id)?;
        }
    }
    w.tx.execute(
        "UPDATE sync_binding SET cursor=?1 WHERE id=1",
        [batch.cursor],
    )?;
    Ok(())
}

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
                w.tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_binding)", [], |r| r.get(0))?;
            if bound {
                return Err(Error::invalid("binding", "already bound; unbind first"));
            }
            w.tx.execute(
                "INSERT INTO sync_binding(id,site_origin,account_hint,remote_user_id,cookie_ciphertext,cookie_name,cookie_domain,cookie_path,cookie_expires_at,cookie_secure,cookie_host_only,cookie_same_site,cursor,created_at) VALUES(1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12)",
                params![binding.site_origin, binding.account_hint, binding.remote_user_id, cookie.ciphertext, cookie.name, cookie.domain, cookie.path, cookie.expires_at, cookie.secure, cookie.host_only, cookie.same_site, w.now.get()],
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
            "DELETE FROM sync_binding;
             DELETE FROM sync_attachment;
             DELETE FROM sync_item WHERE (entity='note' AND id NOT IN (SELECT id FROM notes))
               OR (entity='folder' AND id NOT IN (SELECT id FROM folders WHERE deleted_at IS NULL))
               OR (entity='tag' AND id NOT IN (SELECT id FROM tags));
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
            "UPDATE sync_binding SET cookie_ciphertext=?1,cookie_name=?2,cookie_domain=?3,cookie_path=?4,cookie_expires_at=?5,cookie_secure=?6,cookie_host_only=?7,cookie_same_site=?8 WHERE id=1",
            params![cookie.ciphertext, cookie.name, cookie.domain, cookie.path, cookie.expires_at, cookie.secure, cookie.host_only, cookie.same_site],
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

/// Whether a remote note already carries this local state (used after a lost response).
#[must_use]
pub fn notes_match(local: &Note, remote: &Note) -> bool {
    same_note(local, remote)
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

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
mod tests {
    use super::*;
    use crate::dto::{FolderCreate, TagCreate};
    use crate::write::{NewNote, NotePatch};
    use crate::{Library, LibraryDeps, Millis, RandomIds, Rev};
    use std::sync::Arc;

    const A: &str = "01arz3ndektsv4rrffq69g5fa1";
    const B: &str = "01arz3ndektsv4rrffq69g5fa2";
    const C: &str = "01arz3ndektsv4rrffq69g5fa3";

    struct Clock;
    impl crate::Clock for Clock {
        fn now(&self) -> Result<Millis, Error> {
            Millis::new(1_700_000_000_000)
        }
    }
    struct Quiet;
    impl crate::ChangeSink for Quiet {
        fn library_changed(&self, _: crate::ChangeSet) {}
        fn write_event(&self, _: crate::WriteEvent) {}
    }
    fn library() -> Library {
        Library::open_in_memory(
            crate::db::test_files_dir(),
            LibraryDeps {
                clock: Arc::new(Clock),
                ids: Arc::new(RandomIds),
                sink: Arc::new(Quiet),
            },
        )
        .unwrap()
    }
    fn item(lib: &Library, entity: &str, id: &str) -> Option<(Option<i64>, bool)> {
        lib.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT remote_rev,dirty FROM sync_item WHERE entity=?1 AND id=?2",
                params![entity, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .unwrap()
    }
    fn dirty(lib: &Library, entity: &str, id: &str) -> bool {
        item(lib, entity, id).is_some_and(|(_, dirty)| dirty)
    }
    fn trashed(lib: &Library, id: &str) -> bool {
        lib.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
    }
    fn create(lib: &Library, id: &str, content: &str, origin: WriteOrigin) -> Note {
        lib.create_note(
            &NewNote {
                id: Some(id.parse().unwrap()),
                title: Some("T".into()),
                content: content.into(),
                folder_id: None,
                is_starred: false,
            },
            origin,
        )
        .unwrap()
        .value
    }
    fn edit(lib: &Library, note: &Note, content: &str) -> Note {
        lib.patch_note(
            &note.summary.id,
            &NotePatch {
                rev: note.summary.rev,
                title: None,
                content: Some(content.into()),
                folder_id: None,
                is_pinned: None,
                is_starred: None,
                is_archived: None,
                quiet: false,
                preserve_version: true,
            },
            WriteOrigin::Ui,
        )
        .unwrap()
        .value
    }
    fn remote(id: &str, rev: i64, content: &str) -> Note {
        let mut note = crate::dto::test_note(rev);
        note.summary.id = id.parse().unwrap();
        note.summary.rev = Rev::new(rev).unwrap();
        note.summary.title = "T".into();
        note.summary.folder_id = None;
        note.summary.deleted_at = None;
        note.content = content.into();
        note
    }
    fn bind(lib: &Library, snapshot: &RemoteBatch) {
        lib.sync_bind(
            &Binding {
                site_origin: "https://example.test".into(),
                account_hint: "me".into(),
                remote_user_id: "u1".into(),
            },
            &SyncCookie {
                ciphertext: vec![1],
                name: "session".into(),
                domain: "example.test".into(),
                path: "/".into(),
                expires_at: None,
                secure: true,
                host_only: true,
                same_site: "Lax".into(),
            },
            snapshot,
        )
        .unwrap();
    }
    fn settle_all(lib: &Library) {
        for item in lib.sync_dirty().unwrap() {
            let rev = match &item.row {
                LocalRow::Note(_) => Some(item.remote_rev.unwrap_or(0) + 1),
                _ => item.remote_rev,
            };
            lib.sync_settle(item.entity, &item.id, rev, &item.seen)
                .unwrap();
        }
    }

    #[test]
    fn every_local_write_path_marks_rows_dirty_and_sync_writes_do_not() {
        let lib = library();
        // UI create, edit, copy, trash and empty trash.
        let note = create(&lib, A, "one", WriteOrigin::Ui);
        assert!(dirty(&lib, "note", A));
        settle_all(&lib);
        assert!(!dirty(&lib, "note", A));
        let note = edit(&lib, &note, "two");
        assert!(dirty(&lib, "note", A));
        settle_all(&lib);
        let copy = lib
            .duplicate_note(&note.summary.id, Some(&B.parse().unwrap()), WriteOrigin::Ui)
            .unwrap()
            .value;
        assert!(dirty(&lib, "note", copy.summary.id.as_str()));
        // Version restore.
        let version = lib.list_versions(&note.summary.id).unwrap()[0].id.clone();
        settle_all(&lib);
        let current = lib.get_note(&note.summary.id).unwrap();
        lib.restore_version(
            &note.summary.id,
            &version,
            current.summary.rev,
            WriteOrigin::Ui,
        )
        .unwrap();
        assert!(dirty(&lib, "note", A));
        settle_all(&lib);
        lib.trash_note(&copy.summary.id, WriteOrigin::Ui).unwrap();
        settle_all(&lib);
        lib.empty_trash(WriteOrigin::Ui).unwrap();
        assert!(
            dirty(&lib, "note", B),
            "purged notes stay pending until the remote purge"
        );
        // MCP note and organizer writes.
        settle_all(&lib);
        lib.execute_mcp_write("create_note", &serde_json::json!({"operation_id":"op-create-1","note_id":C,"title":"M","content":"m"})).unwrap();
        assert!(dirty(&lib, "note", C));
        let folder = lib
            .create_folder(
                &FolderCreate {
                    name: Some("F".into()),
                    ..FolderCreate::default()
                },
                WriteOrigin::Mcp,
            )
            .unwrap()
            .value;
        assert!(dirty(&lib, "folder", folder.id.as_str()));
        let tag = lib
            .create_tag(
                &TagCreate {
                    id: None,
                    name: "x".into(),
                    color: None,
                },
                WriteOrigin::Ui,
            )
            .unwrap()
            .value;
        assert!(dirty(&lib, "tag", tag.id.as_str()));
        // Sync-origin writes register nothing.
        settle_all(&lib);
        let before = lib.sync_pending().unwrap();
        lib.create_folder(
            &FolderCreate {
                name: Some("S".into()),
                ..FolderCreate::default()
            },
            WriteOrigin::Sync,
        )
        .unwrap();
        assert_eq!(lib.sync_pending().unwrap(), before);
    }

    #[test]
    fn bind_merges_by_id_and_keeps_both_versions_of_a_differing_note() {
        let lib = library();
        create(&lib, A, "local shared", WriteOrigin::Ui);
        create(&lib, B, "local only", WriteOrigin::Ui);
        let snapshot = RemoteBatch {
            cursor: 7,
            full: true,
            notes: vec![
                remote(A, 3, "remote shared"),
                remote(C, 1, "remote only"),
                remote("01arz3ndektsv4rrffq69g5fa4", 1, "r2"),
            ],
            ..RemoteBatch::default()
        };
        let counts = lib.sync_merge_counts(&snapshot.notes).unwrap();
        assert_eq!(
            counts,
            MergeCounts {
                local_only: 1,
                remote_only: 2,
                same: 0,
                different: 1
            }
        );
        bind(&lib, &snapshot);
        let notes: Vec<(String, String)> = {
            let conn = lib.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT id,content FROM notes ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        assert_eq!(notes.len(), 5, "4 distinct ids plus one conflict copy");
        assert!(notes.contains(&(A.to_owned(), "remote shared".to_owned())));
        assert!(notes.iter().any(|(id, c)| id != A && c == "local shared"));
        assert_eq!(item(&lib, "note", A), Some((Some(3), false)));
        assert_eq!(item(&lib, "note", B), Some((None, true)));
        assert_eq!(item(&lib, "note", C), Some((Some(1), false)));
        assert_eq!(lib.sync_binding().unwrap().unwrap().cursor, 7);
    }

    #[test]
    fn pull_applies_remote_changes_without_overwriting_dirty_notes() {
        let lib = library();
        bind(
            &lib,
            &RemoteBatch {
                cursor: 1,
                full: true,
                notes: vec![remote(A, 1, "a1"), remote(B, 1, "b1"), remote(C, 1, "c1")],
                ..RemoteBatch::default()
            },
        );
        let local_b = lib.get_note(&B.parse().unwrap()).unwrap();
        edit(&lib, &local_b, "b local");
        let folder = Folder {
            id: "01arz3ndektsv4rrffq69g5fa5".parse().unwrap(),
            parent_id: None,
            name: "Remote".into(),
            icon: None,
            color: None,
            position: 1.0,
            created_at: Millis::new(1).unwrap(),
            updated_at: Millis::new(1).unwrap(),
            note_count: None,
        };
        lib.sync_apply(&RemoteBatch {
            cursor: 9,
            full: false,
            notes: vec![remote(A, 2, "a2"), remote(B, 2, "b remote")],
            folders: vec![folder],
            deletions: vec![SyncDeletion {
                entity: DeletedEntity::Note,
                id: C.into(),
            }],
            ..RemoteBatch::default()
        })
        .unwrap();
        assert_eq!(lib.get_note(&A.parse().unwrap()).unwrap().content, "a2");
        assert_eq!(
            lib.get_note(&B.parse().unwrap()).unwrap().content,
            "b local"
        );
        assert!(trashed(&lib, C));
        assert_eq!(lib.list_folders(false).unwrap()[0].name, "Remote");
        assert_eq!(item(&lib, "note", A), Some((Some(2), false)));
        assert_eq!(
            item(&lib, "note", B),
            Some((Some(1), true)),
            "push resolves it via 409"
        );
        assert_eq!(lib.sync_binding().unwrap().unwrap().cursor, 9);
        // Applying the same batch again changes nothing.
        let pending = lib.sync_pending().unwrap();
        lib.sync_apply(&RemoteBatch {
            cursor: 9,
            notes: vec![remote(A, 2, "a2")],
            ..RemoteBatch::default()
        })
        .unwrap();
        assert_eq!(lib.sync_pending().unwrap(), pending);
        // A full snapshot without a confirmed note deletes it; unpushed local notes stay.
        create(&lib, C.replace("a3", "a6").as_str(), "new", WriteOrigin::Ui);
        lib.sync_apply(&RemoteBatch {
            cursor: 10,
            full: true,
            notes: vec![remote(B, 2, "b remote")],
            ..RemoteBatch::default()
        })
        .unwrap();
        assert!(trashed(&lib, A));
        assert!(
            lib.get_note(&"01arz3ndektsv4rrffq69g5fa6".parse().unwrap())
                .is_ok()
        );
    }

    #[test]
    fn settle_keeps_rows_edited_during_push_dirty() {
        let lib = library();
        let note = create(&lib, A, "v1", WriteOrigin::Ui);
        let sent = lib.sync_dirty().unwrap().remove(0);
        edit(&lib, &note, "v2");
        lib.sync_settle(sent.entity, &sent.id, Some(1), &sent.seen)
            .unwrap();
        assert_eq!(item(&lib, "note", A), Some((Some(1), true)));
        let next = lib.sync_dirty().unwrap().remove(0);
        assert!(matches!(&next.row, LocalRow::Note(n) if n.content == "v2"));
        assert_eq!(next.remote_rev, Some(1));
    }

    #[test]
    fn conflict_keeps_server_version_and_a_pending_local_copy() {
        let lib = library();
        bind(
            &lib,
            &RemoteBatch {
                cursor: 1,
                full: true,
                notes: vec![remote(A, 1, "base")],
                ..RemoteBatch::default()
            },
        );
        let local = lib.get_note(&A.parse().unwrap()).unwrap();
        edit(&lib, &local, "mine");
        let item_a = lib.sync_dirty().unwrap().remove(0);
        assert!(
            lib.sync_fork_conflict(&remote(A, 2, "theirs"), &item_a.seen)
                .unwrap()
        );
        assert_eq!(lib.get_note(&A.parse().unwrap()).unwrap().content, "theirs");
        assert_eq!(item(&lib, "note", A), Some((Some(2), false)));
        let pending = lib.sync_dirty().unwrap();
        assert_eq!(pending.len(), 1);
        assert!(
            matches!(&pending[0].row, LocalRow::Note(copy) if copy.content == "mine" && copy.summary.title.contains("冲突")),
            "the local version survives as a conflict copy"
        );
        assert_eq!(pending[0].remote_rev, None);
    }

    #[test]
    fn unbind_keeps_local_data_and_marks_everything_pending() {
        let lib = library();
        bind(
            &lib,
            &RemoteBatch {
                cursor: 1,
                full: true,
                notes: vec![remote(A, 1, "a")],
                ..RemoteBatch::default()
            },
        );
        assert_eq!(lib.sync_pending().unwrap(), 0);
        lib.sync_unbind().unwrap();
        assert!(lib.sync_binding().unwrap().is_none());
        assert_eq!(lib.get_note(&A.parse().unwrap()).unwrap().content, "a");
        assert_eq!(item(&lib, "note", A), Some((None, true)));
    }
}
