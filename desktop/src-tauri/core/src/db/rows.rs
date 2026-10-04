//! Positional SQL projections and typed row decoding for the domain DTOs.
//! Projections deliberately omit worker-only `user_id`; callers use these
//! constants with the matching mapper, never expose a SQLite row or connection.

use rusqlite::{Row, types::Type};

use crate::dto::{Attachment, Folder, Note, NoteSummary, NoteVersion, NoteVersionMeta, Tag};
use crate::error::Error;
use crate::types::{AttachmentId, Millis, Rev};

pub(crate) const NOTE_COLUMNS: &str = "n.id, n.folder_id, n.title, n.excerpt, n.rev, \
    n.word_count, n.char_count, n.is_pinned, n.is_starred, n.is_archived, n.position, \
    n.created_at, n.updated_at, n.deleted_at, \
    (SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt \
      JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id) AS tag_names";

pub(crate) const NOTE_COLUMNS_FULL: &str = "n.id, n.folder_id, n.title, n.excerpt, n.rev, \
    n.word_count, n.char_count, n.is_pinned, n.is_starred, n.is_archived, n.position, \
    n.created_at, n.updated_at, n.deleted_at, \
    (SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt \
      JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id) AS tag_names, n.content";

pub(crate) const FOLDER_COLUMNS: &str = "f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at, (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id AND n.deleted_at IS NULL) AS note_count";
pub(crate) const TAG_COLUMNS: &str = "t.id, t.name, t.color, t.created_at, (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id WHERE nt.tag_id = t.id AND n.deleted_at IS NULL) AS note_count";
pub(crate) const VERSION_COLUMNS: &str = "id, note_id, title, size, created_at";
pub(crate) const ATTACHMENT_COLUMNS: &str =
    "id, note_id, filename, mime, size, width, height, created_at";

fn checked<T>(value: String, index: usize) -> rusqlite::Result<T>
where
    T: TryFrom<String, Error = Error>,
{
    T::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn checked_time(value: i64, index: usize) -> rusqlite::Result<Millis> {
    Millis::new(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}
fn checked_count(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}

pub(crate) fn note_summary(row: &Row<'_>) -> rusqlite::Result<NoteSummary> {
    let tags: Option<String> = row.get(14)?;
    let mut tags: Vec<String> = tags
        .as_deref()
        .unwrap_or_default()
        .split('\u{1}')
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .collect();
    crate::markdown::sort_tag_names(&mut tags);
    Ok(NoteSummary {
        id: checked(row.get(0)?, 0)?,
        folder_id: row
            .get::<_, Option<String>>(1)?
            .map(|id| checked(id, 1))
            .transpose()?,
        title: row.get(2)?,
        excerpt: row.get(3)?,
        rev: Rev::new(row.get(4)?).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, Type::Integer, Box::new(e))
        })?,
        word_count: checked_count(row, 5)?,
        char_count: checked_count(row, 6)?,
        is_pinned: row.get::<_, i64>(7)? == 1,
        is_starred: row.get::<_, i64>(8)? == 1,
        is_archived: row.get::<_, i64>(9)? == 1,
        position: row.get(10)?,
        created_at: checked_time(row.get(11)?, 11)?,
        updated_at: checked_time(row.get(12)?, 12)?,
        deleted_at: row
            .get::<_, Option<i64>>(13)?
            .map(|time| checked_time(time, 13))
            .transpose()?,
        tags,
    })
}

pub(crate) fn note(row: &Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        summary: note_summary(row)?,
        content: row.get(15)?,
    })
}

pub(crate) fn folder(row: &Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: checked(row.get(0)?, 0)?,
        parent_id: row
            .get::<_, Option<String>>(1)?
            .map(|id| checked(id, 1))
            .transpose()?,
        name: row.get(2)?,
        icon: row.get(3)?,
        color: row.get(4)?,
        position: row.get(5)?,
        created_at: checked_time(row.get(6)?, 6)?,
        updated_at: checked_time(row.get(7)?, 7)?,
        note_count: row
            .get::<_, Option<i64>>(8)?
            .map(|value| {
                u64::try_from(value).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(8, Type::Integer, Box::new(error))
                })
            })
            .transpose()?,
    })
}

pub(crate) fn tag(row: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: checked(row.get(0)?, 0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: checked_time(row.get(3)?, 3)?,
        count: checked_count(row, 4)?,
    })
}

pub(crate) fn version_meta(row: &Row<'_>) -> rusqlite::Result<NoteVersionMeta> {
    Ok(NoteVersionMeta {
        id: checked(row.get(0)?, 0)?,
        note_id: checked(row.get(1)?, 1)?,
        title: row.get(2)?,
        size: checked_count(row, 3)?,
        created_at: checked_time(row.get(4)?, 4)?,
    })
}

pub(crate) fn version(row: &Row<'_>) -> rusqlite::Result<NoteVersion> {
    Ok(NoteVersion {
        meta: version_meta(row)?,
        content: row.get(5)?,
    })
}

pub(crate) fn attachment(row: &Row<'_>) -> rusqlite::Result<Attachment> {
    let id: AttachmentId = checked(row.get(0)?, 0)?;
    Ok(Attachment {
        url: format!("/api/files/{id}"),
        id,
        note_id: row
            .get::<_, Option<String>>(1)?
            .map(|id| checked(id, 1))
            .transpose()?,
        filename: row.get(2)?,
        mime: row.get(3)?,
        size: checked_count(row, 4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        created_at: checked_time(row.get(7)?, 7)?,
    })
}
