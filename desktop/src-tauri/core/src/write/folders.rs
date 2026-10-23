use super::{WriteOrigin, Written};
use crate::db::rows::{FOLDER_COLUMNS, NOTE_COLUMNS, folder, note_summary};
use crate::dto::{Folder, FolderCreate, FolderPatch};
use crate::error::{Entity, Error};
use crate::markdown::truncate_utf16;
use crate::types::{FolderId, Rev};
use rusqlite::{OptionalExtension, Transaction, params};

/// How to handle a folder's children and notes when removing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderDeleteStrategy {
    MoveUp,
    Delete,
}

/// Number of folders removed and notes moved or soft-deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderDeleteResult {
    pub folders: u64,
    pub notes: u64,
}

pub(crate) fn name(raw: &str) -> Result<&str, Error> {
    let name = raw.trim();
    if name.is_empty() || name.encode_utf16().count() > 120 {
        return Err(Error::invalid("name", "must be 1 to 120 UTF-16 units"));
    }
    Ok(name)
}
/// Web `truncateText(icon, 8) || null`.
fn icon(value: Option<&str>) -> Option<String> {
    value
        .map(|v| truncate_utf16(v, 8))
        .filter(|v| !v.is_empty())
}
pub(crate) fn color(value: Option<&str>) -> Result<(), Error> {
    if value.is_some_and(|value| {
        !matches!(
            value,
            "#dc2626"
                | "#ea580c"
                | "#ca8a04"
                | "#65a30d"
                | "#059669"
                | "#0891b2"
                | "#4f46e5"
                | "#9333ea"
                | "#db2777"
                | "#64748b"
        )
    }) {
        return Err(Error::invalid("color", "unsupported organizer color"));
    }
    Ok(())
}
fn load(tx: &Transaction<'_>, id: &str) -> Result<Folder, Error> {
    let sql =
        format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.id=?1 AND f.deleted_at IS NULL");
    tx.query_row(&sql, [id], folder)
        .optional()?
        .ok_or(Error::NotFound {
            entity: Entity::Folder,
            id: id.into(),
        })
}
pub(crate) fn check_parent(
    tx: &Transaction<'_>,
    parent: Option<&FolderId>,
    self_id: Option<&FolderId>,
) -> Result<(), Error> {
    if let Some(parent) = parent {
        let found: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 AND deleted_at IS NULL)",
            [parent.as_str()],
            |r| r.get(0),
        )?;
        if !found {
            return Err(Error::NotFound {
                entity: Entity::Folder,
                id: parent.to_string(),
            });
        }
        let mut current = Some(parent.to_string());
        let mut depth = 0;
        while let Some(id) = current {
            if self_id.is_some_and(|own| own.as_str() == id) {
                return Err(Error::invalid("parentId", "folder cycle"));
            }
            depth += 1;
            if depth >= 12 {
                return Err(Error::invalid("parentId", "folder depth exceeds 12"));
            }
            current = tx.query_row(
                "SELECT parent_id FROM folders WHERE id=?1 AND deleted_at IS NULL",
                [id],
                |r| r.get(0),
            )?;
        }
    }
    Ok(())
}
pub(crate) fn height(tx: &Transaction<'_>, id: &str) -> Result<i64, Error> {
    Ok(tx.query_row(
        "WITH RECURSIVE tree(id,depth) AS (SELECT id,1 FROM folders WHERE id=?1 UNION ALL SELECT f.id,t.depth+1 FROM folders f JOIN tree t ON f.parent_id=t.id WHERE f.deleted_at IS NULL AND t.depth<=12) SELECT MAX(depth) FROM tree",
        [id],
        |r| r.get::<_, Option<i64>>(0),
    )?.unwrap_or(0))
}
pub(crate) fn depth(tx: &Transaction<'_>, parent: Option<&FolderId>) -> Result<i64, Error> {
    let mut current = parent.map(|p| p.as_str().to_owned());
    let mut depth = 0;
    while let Some(id) = current {
        depth += 1;
        if depth > 12 {
            return Err(Error::invalid("parentId", "folder depth exceeds 12"));
        }
        current = tx.query_row("SELECT parent_id FROM folders WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
    }
    Ok(depth)
}
pub(crate) fn check_name(
    tx: &Transaction<'_>,
    parent: Option<&FolderId>,
    name: &str,
    exclude: Option<&str>,
) -> Result<(), Error> {
    let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE parent_id IS ?1 AND name=?2 COLLATE NOCASE AND deleted_at IS NULL AND id<>COALESCE(?3,''))", params![parent.map(FolderId::as_str), name, exclude], |r| r.get(0))?;
    if duplicate {
        Err(Error::Duplicate {
            entity: Entity::Folder,
        })
    } else {
        Ok(())
    }
}
/// Web `availableFolderName`: `base`, then `base 2`, `base 3`...
fn available_name(
    tx: &Transaction<'_>,
    parent: Option<&FolderId>,
    base: &str,
) -> Result<String, Error> {
    let taken = |n: &str| -> Result<bool, Error> {
        Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE parent_id IS ?1 AND name=?2 COLLATE NOCASE AND deleted_at IS NULL)", params![parent.map(FolderId::as_str), n], |r| r.get(0))?)
    };
    if !taken(base)? {
        return Ok(base.to_owned());
    }
    let mut suffix = 2;
    while taken(&format!("{base} {suffix}"))? {
        suffix += 1;
    }
    Ok(format!("{base} {suffix}"))
}
fn siblings(
    tx: &Transaction<'_>,
    parent: Option<&FolderId>,
    exclude: &str,
) -> Result<Vec<(String, f64)>, Error> {
    let mut stmt = tx.prepare("SELECT id,position FROM folders WHERE parent_id IS ?1 AND deleted_at IS NULL AND id<>?2 ORDER BY position,created_at,id")?;
    let rows = stmt.query_map(params![parent.map(FolderId::as_str), exclude], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
/// Web `insertionPosition`.
fn between(previous: Option<f64>, next: Option<f64>) -> Option<f64> {
    match (previous, next) {
        (None, None) => Some(1000.0),
        (None, Some(next)) => Some(next - 1000.0),
        (Some(previous), None) => Some(previous + 1000.0),
        (Some(previous), Some(next)) => {
            let p = previous + (next - previous) / 2.0;
            (p.is_finite() && p > previous && p < next).then_some(p)
        }
    }
}
/// Web `resolveFolderPosition`: `None` = order unchanged. Renumbers
/// siblings to 1000 steps when floating-point gaps run out.
fn place(
    w: &mut super::WriteTx<'_>,
    id: &str,
    old_parent: Option<&FolderId>,
    parent: Option<&FolderId>,
    before: Option<&FolderId>,
) -> Result<Option<f64>, Error> {
    let index = |list: &[(String, f64)]| match before {
        None => Ok(list.len()),
        Some(b) => list
            .iter()
            .position(|(i, _)| i == b.as_str())
            .ok_or(Error::invalid(
                "beforeId",
                "The target folder is not in the destination",
            )),
    };
    let mut list = siblings(&w.tx, parent, id)?;
    let mut at = index(&list)?;
    if old_parent == parent {
        let current = siblings(&w.tx, parent, "")?;
        let mut desired: Vec<&str> = list.iter().map(|(i, _)| i.as_str()).collect();
        desired.insert(at, id);
        if current.iter().map(|(i, _)| i.as_str()).eq(desired) {
            return Ok(None);
        }
    }
    let pick = |list: &[(String, f64)], at: usize| {
        between(
            at.checked_sub(1).map(|i| list[i].1),
            list.get(at).map(|s| s.1),
        )
    };
    if let Some(p) = pick(&list, at) {
        return Ok(Some(p));
    }
    for (n, (sibling, position)) in list.iter().enumerate() {
        let target = ((n + 1) * 1000) as f64;
        if *position != target {
            w.tx.execute(
                "UPDATE folders SET position=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",
                params![target, w.now.get(), sibling],
            )?;
            record(w, sibling, "upsert")?;
        }
    }
    list = siblings(&w.tx, parent, id)?;
    at = index(&list)?;
    pick(&list, at).map(Some).ok_or(Error::invalid(
        "beforeId",
        "The folder order changed. Try again",
    ))
}
fn record(w: &mut super::WriteTx<'_>, id: &str, op: &str) -> Result<(), Error> {
    w.tx.execute(
        "INSERT INTO changes(entity,entity_id,op,at) VALUES('folder',?1,?2,?3)",
        params![id, op, w.now.get()],
    )?;
    w.mark(super::DirtyEntity::Folder, id);
    Ok(())
}

impl crate::db::Library {
    /// Lists active folders, or all rows including tombstones.
    /// # Errors
    /// Returns a database or row-decoding error.
    pub fn list_folders(&self, include_deleted: bool) -> Result<Vec<Folder>, Error> {
        self.read(|db| {
            let sql = format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE (?1 OR f.deleted_at IS NULL) ORDER BY f.parent_id, f.position, f.id");
            let mut stmt=db.prepare(&sql)?;
            Ok(stmt.query_map([include_deleted], folder)?.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }
    /// Mirrors Web `POST /folders`: an existing `id` is returned as-is; empty name
    /// becomes `New folder`/`New folder 2`; appended after the last sibling.
    /// # Errors
    /// Rejects invalid inputs, missing parents, duplicate sibling names or database errors.
    pub fn create_folder(
        &self,
        input: &FolderCreate,
        origin: WriteOrigin,
    ) -> Result<Written<Folder>, Error> {
        self.write(origin, |w| {
            if let Some(id) = &input.id {
                if let Ok(existing) = load(&w.tx, id.as_str()) { return Ok(existing); }
            }
            color(input.color.as_deref())?;
            check_parent(&w.tx, input.parent_id.as_ref(), None)?;
            let parent = input.parent_id.as_ref();
            let requested = input.name.as_deref().unwrap_or("").trim();
            let next_name = if requested.is_empty() { available_name(&w.tx, parent, "New folder")? } else { name(requested)?.to_owned() };
            check_name(&w.tx, parent, &next_name, None)?;
            let id = match &input.id { Some(id) => id.to_string(), None => w.id()? };
            let position = match &input.before_id {
                Some(_) => place(w, &id, parent, parent, input.before_id.as_ref())?.unwrap_or(1000.0),
                None => w.tx.query_row("SELECT COALESCE(MAX(position),0)+1000 FROM folders WHERE parent_id IS ?1 AND deleted_at IS NULL", [parent.map(FolderId::as_str)], |r| r.get(0))?,
            };
            w.tx.execute("INSERT INTO folders(id,parent_id,name,icon,color,position,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)", params![id,parent.map(FolderId::as_str),next_name,icon(input.icon.as_deref()),input.color,position,w.now.get()])?;
            record(w,&id,"upsert")?;
            load(&w.tx,&id)
        })
    }
    /// Mirrors Web `PATCH /folders/:id`: absent fields stay; `beforeId` needs `parentId`.
    /// # Errors
    /// Rejects invalid inputs, cycles, duplicate sibling names and database errors.
    pub fn patch_folder(
        &self,
        id: &FolderId,
        input: &FolderPatch,
        origin: WriteOrigin,
    ) -> Result<Written<Folder>, Error> {
        self.write(origin, |w| {
            let old=load(&w.tx,id.as_str())?;
            if input.before_id.is_some() && input.parent_id.is_none() {
                return Err(Error::invalid("parentId", "parentId is required when reordering a folder"));
            }
            if input.before_id.as_ref().is_some_and(|b| b.as_ref() == Some(id)) {
                return Err(Error::invalid("beforeId", "A folder cannot be placed before itself"));
            }
            let next_name = match &input.name { Some(n) => name(n)?.to_owned(), None => old.name.clone() };
            let next_icon = match &input.icon { Some(v) => icon(v.as_deref()), None => old.icon.clone() };
            let next_color = match &input.color { Some(v) => { color(v.as_deref())?; v.clone() } None => old.color.clone() };
            let parent = match &input.parent_id { Some(p) => p.clone(), None => old.parent_id.clone() };
            if input.parent_id.is_some() {
                check_parent(&w.tx, parent.as_ref(), Some(id))?;
                if depth(&w.tx, parent.as_ref())? + height(&w.tx, id.as_str())? > 12 {
                    return Err(Error::invalid("parentId", "folder depth exceeds 12"));
                }
            }
            check_name(&w.tx, parent.as_ref(), &next_name, Some(id.as_str()))?;
            let position = if input.before_id.is_some() || parent != old.parent_id {
                place(w, id.as_str(), old.parent_id.as_ref(), parent.as_ref(), input.before_id.clone().flatten().as_ref())?.unwrap_or(old.position)
            } else { old.position };
            if old.parent_id==parent && old.name==next_name && old.icon==next_icon && old.color==next_color && old.position==position { return Ok(old); }
            let now=w.now.get().max(old.updated_at.get().saturating_add(1));
            w.tx.execute("UPDATE folders SET parent_id=?1,name=?2,icon=?3,color=?4,position=?5,updated_at=?6 WHERE id=?7",params![parent.as_ref().map(FolderId::as_str),next_name,next_icon,next_color,position,now,id.as_str()])?;
            record(w,id.as_str(),"upsert")?;
            load(&w.tx,id.as_str())
        })
    }
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
            let old=load(&w.tx,id.as_str())?;
            let mut folders=Vec::new();
            match strategy {
                FolderDeleteStrategy::MoveUp => {
                    let mut stmt=w.tx.prepare("SELECT id,name FROM folders WHERE parent_id=?1 AND deleted_at IS NULL ORDER BY position,id")?;
                    let children=stmt.query_map([id.as_str()],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(stmt);
                    for (_, child_name) in &children { check_name(&w.tx,old.parent_id.as_ref(),child_name,Some(id.as_str()))?; }
                    // Positions remain stable unless a sibling occupies one: insertion order is
                    // deterministic even for a folder promoted between two existing siblings.
                    for (child,_) in &children {
                        w.tx.execute("UPDATE folders SET parent_id=?1,updated_at=MAX(updated_at+1,?2) WHERE id=?3",params![old.parent_id.as_ref().map(FolderId::as_str),w.now.get(),child])?;
                        record(w,child,"upsert")?;
                    }
                    folders.push(id.to_string());
                }
                FolderDeleteStrategy::Delete => {
                    let mut stmt=w.tx.prepare("WITH RECURSIVE tree(id,depth) AS (SELECT id,1 FROM folders WHERE id=?1 AND deleted_at IS NULL UNION ALL SELECT f.id,t.depth+1 FROM folders f JOIN tree t ON f.parent_id=t.id WHERE f.deleted_at IS NULL AND t.depth<=12) SELECT id FROM tree")?;
                    folders=stmt.query_map([id.as_str()],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                }
            }
            let note_ids={
                let mut stmt=w.tx.prepare(match strategy {
                    FolderDeleteStrategy::MoveUp => "SELECT id FROM notes WHERE folder_id=?1",
                    FolderDeleteStrategy::Delete => "WITH RECURSIVE tree(id,depth) AS (SELECT id,1 FROM folders WHERE id=?1 UNION ALL SELECT f.id,t.depth+1 FROM folders f JOIN tree t ON f.parent_id=t.id WHERE f.deleted_at IS NULL AND t.depth<=12) SELECT id FROM notes WHERE folder_id IN (SELECT id FROM tree)",
                })?;
                let rows=stmt.query_map([id.as_str()],|r|r.get::<_,String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for note_id in &note_ids {
                let (note_title, note_content, current_rev, updated): (String, String, i64, i64) = w.tx.query_row(
                    "SELECT title,content,rev,updated_at FROM notes WHERE id=?1", [note_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
                let now=w.now.get().max(updated.saturating_add(1));
                Rev::new(current_rev+1)?;
                if strategy==FolderDeleteStrategy::Delete {
                    w.tx.execute("UPDATE notes SET folder_id=NULL,deleted_at=COALESCE(?1,deleted_at),rev=rev+1,updated_at=?1 WHERE id=?2",params![now,note_id])?;
                    super::derived::derive(&w.tx,w.ids.as_ref(),note_id,&note_title,&note_content,true,w.now,Some(&crate::markdown::normalize_link_key(&note_title)))?;
                } else {
                    w.tx.execute("UPDATE notes SET folder_id=?1,rev=rev+1,updated_at=?2 WHERE id=?3",params![old.parent_id.as_ref().map(FolderId::as_str),now,note_id])?;
                }
                w.record_change(note_id,"upsert")?;
                let sql=format!("SELECT {NOTE_COLUMNS} FROM notes n WHERE n.id=?1");
                w.touch_note(w.tx.query_row(&sql,[note_id],note_summary)?);
            }
            if strategy==FolderDeleteStrategy::Delete {
                w.tx.execute("UPDATE links SET target_note_id=(SELECT n.id FROM notes n WHERE n.title_key=links.target_key AND n.deleted_at IS NULL ORDER BY n.created_at,n.id LIMIT 1) WHERE target_note_id IN (SELECT id FROM notes WHERE deleted_at IS NOT NULL)",[])?;
            }
            for folder_id in &folders {
                w.tx.execute("UPDATE folders SET deleted_at=?1,updated_at=MAX(updated_at+1,?1) WHERE id=?2",params![w.now.get(),folder_id])?;
                record(w,folder_id,"delete")?;
                w.delete(folder_id.clone());
            }
            Ok(FolderDeleteResult { folders: folders.len() as u64, notes: note_ids.len() as u64 })
        })
    }
}
