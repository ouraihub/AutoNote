use rusqlite::{OptionalExtension, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

use crate::db::{Library, rows};
use crate::dto::{Backlink, ListNotesResponse, Note, NoteVersion, NoteVersionMeta};
use crate::error::{Entity, Error};
use crate::markdown::to_plain_text;
use crate::types::{FolderId, NoteId, VersionId};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteView {
    #[default]
    All,
    Recent,
    Starred,
    Unfiled,
    Archived,
    Trash,
    Folder,
    Tag,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteSort {
    #[default]
    Updated,
    Created,
    Title,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteOrder {
    Asc,
    #[default]
    Desc,
}

/// Strictly decoded list filters. Unknown keys and invalid enum strings are errors.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListNotesQuery {
    #[serde(default)]
    pub view: NoteView,
    pub folder_id: Option<FolderId>,
    pub tag: Option<String>,
    #[serde(default)]
    pub sort: NoteSort,
    #[serde(default)]
    pub order: NoteOrder,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageKey {
    view: NoteView,
    sort: NoteSort,
    order: NoteOrder,
    folder_id: Option<FolderId>,
    tag: Option<String>,
    id: NoteId,
    pinned: i64,
    value: serde_json::Value,
}

impl Library {
    /// Lists summaries with stable pinned-first keyset pagination and filtered total.
    /// # Errors
    /// Returns `bad_request` for malformed filters or cursors and SQLite errors on read failure.
    pub fn list_notes(&self, query: &ListNotesQuery) -> Result<ListNotesResponse, Error> {
        let limit = query.limit.unwrap_or(100);
        if !(1..=200).contains(&limit) {
            return Err(Error::invalid("limit", "must be between 1 and 200"));
        }
        if matches!(query.view, NoteView::Folder) != query.folder_id.is_some()
            || matches!(query.view, NoteView::Tag) != query.tag.is_some()
        {
            return Err(Error::invalid(
                "view",
                "folder and tag filters require the matching view",
            ));
        }
        if query
            .tag
            .as_ref()
            .is_some_and(|tag| tag.trim().is_empty() || tag.len() > 256)
        {
            return Err(Error::invalid("tag", "invalid tag name"));
        }
        let key = query
            .cursor
            .as_deref()
            .map(|cursor| {
                if cursor.len() > 4096 || !cursor.starts_with("n1.") {
                    return Err(Error::invalid("cursor", "invalid cursor"));
                }
                let key: PageKey = serde_json::from_str(&cursor[3..])
                    .map_err(|_| Error::invalid("cursor", "invalid cursor"))?;
                if key.view != query.view
                    || key.sort != query.sort
                    || key.order != query.order
                    || key.folder_id != query.folder_id
                    || key.tag != query.tag
                    || key.pinned > 1
                    || key.pinned < 0
                    || (matches!(query.view, NoteView::Trash) && key.pinned != 0)
                    || (matches!(query.sort, NoteSort::Title)
                        && !matches!(query.view, NoteView::Trash)
                        && key
                            .value
                            .as_str()
                            .is_none_or(|v| v.encode_utf16().count() > 512))
                    || ((!matches!(query.sort, NoteSort::Title)
                        || matches!(query.view, NoteView::Trash))
                        && key.value.as_i64().is_none_or(|v| v < 0))
                {
                    return Err(Error::invalid("cursor", "invalid cursor"));
                }
                Ok(key)
            })
            .transpose()?;
        self.read(|conn| {
            let mut binds = Vec::<Value>::new();
            let mut where_sql = String::from(if matches!(query.view, NoteView::Trash) { "n.deleted_at IS NOT NULL" } else if matches!(query.view, NoteView::Archived) { "n.deleted_at IS NULL AND n.is_archived=1" } else { "n.deleted_at IS NULL AND n.is_archived=0" });
            if matches!(query.view, NoteView::Starred) { where_sql.push_str(" AND n.is_starred=1"); }
            if matches!(query.view, NoteView::Unfiled) { where_sql.push_str(" AND n.folder_id IS NULL"); }
            if let Some(folder) = &query.folder_id { binds.push(folder.as_str().to_owned().into()); where_sql.push_str(" AND n.folder_id=?"); }
            if let Some(tag) = &query.tag { binds.push(tag.clone().into()); where_sql.push_str(" AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=n.id AND t.name=? COLLATE NOCASE)"); }
            let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM notes n WHERE {where_sql}"), params_from_iter(&binds), |r| r.get(0))?;
            let column = if matches!(query.view, NoteView::Trash) { "n.deleted_at" } else { match query.sort { NoteSort::Updated => "n.updated_at", NoteSort::Created => "n.created_at", NoteSort::Title => "n.title COLLATE NOCASE" } };
            let dir = if matches!(query.order, NoteOrder::Asc) { "ASC" } else { "DESC" };
            let cmp = if matches!(query.order, NoteOrder::Asc) { ">" } else { "<" };
            if let Some(key) = &key {
                let value = match &key.value { serde_json::Value::String(s) => Value::Text(s.clone()), serde_json::Value::Number(n) => Value::Integer(n.as_i64().ok_or(Error::invalid("cursor", "invalid value"))?), _ => return Err(Error::invalid("cursor", "invalid value")) };
                if matches!(query.view, NoteView::Trash) {
                    where_sql.push_str(&format!(" AND ({column} {cmp} ? OR ({column}=? AND n.id>?))"));
                    binds.extend([value.clone(), value, key.id.as_str().to_owned().into()]);
                } else {
                    where_sql.push_str(&format!(" AND (n.is_pinned<? OR (n.is_pinned=? AND ({column} {cmp} ? OR ({column}=? AND n.id>?))))"));
                    binds.extend([key.pinned.into(), key.pinned.into(), value.clone(), value, key.id.as_str().to_owned().into()]);
                }
            }
            let order_by = if matches!(query.view, NoteView::Trash) { format!("{column} {dir}, n.id ASC") } else { format!("n.is_pinned DESC, {column} {dir}, n.id ASC") };
            let sql = format!("SELECT {} FROM notes n WHERE {where_sql} ORDER BY {order_by} LIMIT ?", rows::NOTE_COLUMNS);
            binds.push((limit + 1).into());
            let mut stmt = conn.prepare(&sql)?;
            let results = stmt.query_map(params_from_iter(&binds), rows::note_summary)?;
            let mut notes = results.collect::<rusqlite::Result<Vec<_>>>()?;
            let has_more = notes.len() > limit as usize;
            notes.truncate(limit as usize);
            let next_cursor = if has_more { notes.last().map(|n| {
                let value = if matches!(query.view, NoteView::Trash) { serde_json::json!(n.deleted_at.map_or(0, |v| v.get())) } else { match query.sort { NoteSort::Updated => serde_json::json!(n.updated_at.get()), NoteSort::Created => serde_json::json!(n.created_at.get()), NoteSort::Title => serde_json::json!(n.title) } };
                serde_json::to_string(&PageKey { view: query.view, sort: query.sort, order: query.order, folder_id: query.folder_id.clone(), tag: query.tag.clone(), pinned: if matches!(query.view, NoteView::Trash) { 0 } else { i64::from(n.is_pinned) }, value, id: n.id.clone() }).map(|encoded| format!("n1.{encoded}")).map_err(|_| Error::invalid("cursor", "cannot encode cursor"))
            }).transpose()? } else { None };
            Ok(ListNotesResponse { notes, next_cursor, total: total as u64 })
        })
    }

    /// Reads an existing note, including its content; deleted notes report their deletion cursor.
    /// # Errors
    /// Returns `not_found` with deletion cursor for a missing or deleted note.
    pub fn get_note(&self, id: &NoteId) -> Result<Note, Error> {
        self.read(|conn| {
        let sql = format!("SELECT {} FROM notes n WHERE n.id=?1", rows::NOTE_COLUMNS_FULL);
        let note: Option<Note> = conn.query_row(&sql, [id.as_str()], rows::note).optional()?;
        match note { Some(n) if n.summary.deleted_at.is_none() => Ok(n), _ => {
            let cursor: Option<i64> = conn.query_row("SELECT MAX(seq) FROM changes WHERE entity='note' AND entity_id=?1 AND op='delete'", [id.as_str()], |r| r.get(0))?;
            Err(Error::NoteGone { deletion_cursor: cursor.map(crate::types::Cursor::new).transpose()? })
        } }
    })
    }

    /// Returns the most recent 100 snapshots with deterministic tie-breaking.
    /// # Errors
    /// Returns a SQLite error if history cannot be read.
    pub fn list_versions(&self, id: &NoteId) -> Result<Vec<NoteVersionMeta>, Error> {
        self.read(|conn| {
        let mut stmt = conn.prepare("SELECT id,note_id,title,size,created_at FROM note_versions WHERE note_id=?1 ORDER BY created_at DESC,id DESC LIMIT 100")?;
        Ok(stmt.query_map([id.as_str()], rows::version_meta)?.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    }

    /// Reads only a version owned by this note.
    /// # Errors
    /// Returns not_found when the version does not belong to the requested note.
    pub fn get_version(&self, id: &NoteId, version: &VersionId) -> Result<NoteVersion, Error> {
        self.read(|conn| {
        conn.query_row("SELECT id,note_id,title,size,created_at,content FROM note_versions WHERE note_id=?1 AND id=?2", params![id.as_str(),version.as_str()], rows::version).optional()?.ok_or_else(|| Error::NotFound {entity: Entity::Version, id: version.to_string()})
    })
    }

    /// Returns distinct live notes linking to this note, newest first.
    /// # Errors
    /// Returns not_found for a missing target, or a SQLite error.
    pub fn backlinks(&self, id: &NoteId) -> Result<Vec<Backlink>, Error> {
        let target = self.get_note(id)?;
        self.read(|conn| {
            let mut stmt = conn.prepare("SELECT DISTINCT n.id,n.title,n.content FROM links l JOIN notes n ON n.id=l.source_note_id WHERE (l.target_note_id=?1 OR l.target_key=?2) AND n.deleted_at IS NULL AND n.id<>?1 ORDER BY n.updated_at DESC,n.id ASC LIMIT 50")?;
            let key = crate::markdown::normalize_link_key(&target.summary.title);
            let rows = stmt.query_map(params![id.as_str(),key], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?;
            let mut result = Vec::new();
            for row in rows { let (raw,title,body)=row?; result.push(Backlink { id: NoteId::try_from(raw)?, title, context: crate::markdown::truncate_utf16(&to_plain_text(&body), 160) }); }
            Ok(result)
        })
    }
}
