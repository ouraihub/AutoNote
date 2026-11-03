use super::super::CancellationToken;
use super::super::format::{AttachmentEntry, PlanNote};
use super::super::stage::Stage;
use super::super::{export, format};
use crate::{Error, Folder, Tag};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

pub(super) fn plan(stage: &Stage, bundle: &Value, cancel: &CancellationToken) -> Result<(), Error> {
    if bundle.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(format::invalid());
    }
    let folders = bundle
        .get("folders")
        .and_then(Value::as_array)
        .ok_or_else(format::invalid)?;
    let tags = bundle
        .get("tags")
        .and_then(Value::as_array)
        .ok_or_else(format::invalid)?;
    let attachments = bundle
        .get("attachments")
        .and_then(Value::as_array)
        .ok_or_else(format::invalid)?;
    if folders.len() > format::ENTRY_MAX
        || tags.len() > format::ENTRY_MAX * 2
        || attachments.len() > format::ENTRY_MAX
    {
        return Err(format::invalid());
    }
    let typed_folders: Vec<Folder> =
        serde_json::from_value(Value::Array(folders.clone())).map_err(|_| format::invalid())?;
    let typed_tags: Vec<Tag> =
        serde_json::from_value(Value::Array(tags.clone())).map_err(|_| format::invalid())?;
    validate_folders(&typed_folders)?;
    validate_tags(&typed_tags)?;
    stage.db.execute(
        "INSERT INTO metadata VALUES('json-folders',?1)",
        [serde_json::to_string(&typed_folders).map_err(|_| format::invalid())?],
    )?;
    stage.db.execute(
        "INSERT INTO metadata VALUES('json-tags',?1)",
        [serde_json::to_string(&typed_tags).map_err(|_| format::invalid())?],
    )?;
    for raw in attachments {
        add_attachment(stage, raw, cancel)?;
    }
    if tags.iter().any(|t| {
        t.get("name")
            .and_then(Value::as_str)
            .is_none_or(|n| n.is_empty() || n.encode_utf16().count() > 60)
    }) {
        return Err(format::invalid());
    }
    let notes = bundle
        .get("notes")
        .and_then(Value::as_array)
        .ok_or_else(format::invalid)?;
    if notes.len() > format::ENTRY_MAX * 4 {
        return Err(format::invalid());
    }
    for raw in notes {
        add_note(stage, raw, folders, cancel)?;
    }
    Ok(())
}

fn validate_folders(folders: &[Folder]) -> Result<(), Error> {
    let mut ids = std::collections::HashSet::new();
    for folder in folders {
        format::folder_valid(std::slice::from_ref(&folder.name))?;
        format::timestamp(folder.created_at.get())?;
        format::timestamp(folder.updated_at.get())?;
        if !ids.insert(folder.id.as_str()) || !folder.position.is_finite() {
            return Err(format::invalid());
        }
        let mut parent = folder.parent_id.as_ref();
        let mut depth = 1;
        while let Some(id) = parent {
            depth += 1;
            if depth > 12 {
                return Err(format::invalid());
            }
            parent = folders
                .iter()
                .find(|f| &f.id == id)
                .ok_or_else(format::invalid)?
                .parent_id
                .as_ref();
        }
    }
    Ok(())
}

fn validate_tags(tags: &[Tag]) -> Result<(), Error> {
    let mut ids = std::collections::HashSet::new();
    for tag in tags {
        format::timestamp(tag.created_at.get())?;
        if !ids.insert(tag.id.as_str())
            || tag.name.trim().is_empty()
            || tag.name.encode_utf16().count() > 60
        {
            return Err(format::invalid());
        }
    }
    Ok(())
}

fn add_attachment(stage: &Stage, raw: &Value, cancel: &CancellationToken) -> Result<(), Error> {
    cancel.check()?;
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|v| crate::id::is_valid_id(v))
        .ok_or_else(format::invalid)?;
    let path = raw
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(format::invalid)?;
    format::safe_path(path)?;
    let filename = raw
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(format::invalid)?;
    let mime = raw
        .get("mime")
        .and_then(Value::as_str)
        .ok_or_else(format::invalid)?;
    let size = raw
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(format::invalid)?;
    let hash = raw
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|h| format::hash_valid(h))
        .ok_or_else(format::invalid)?;
    let created_at = raw
        .get("createdAt")
        .and_then(Value::as_i64)
        .ok_or_else(format::invalid)?;
    let prefix: String = stage
        .db
        .query_row(
            "SELECT value FROM metadata WHERE key='bundle-prefix'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();
    let source_path = if prefix.is_empty() {
        path.to_owned()
    } else {
        format!("{prefix}/{path}")
    };
    let (_, actual, actual_hash) = stage.entry(&source_path)?;
    if actual != size || actual_hash != hash {
        return Err(format::invalid());
    }
    let target = format!("attachments/{hash}--{}", export::safe_segment(filename));
    let entry = AttachmentEntry {
        path: target.clone(),
        filename: filename.to_owned(),
        mime: mime.to_owned(),
        size,
        sha256: hash.to_owned(),
        created_at,
    };
    entry.validate()?;
    format::validate_attachment_file(stage.entry(&source_path)?.0, &entry)?;
    stage.db.execute(
        "INSERT OR IGNORE INTO entries SELECT ?1,object,size,hash FROM entries WHERE path=?2",
        params![target, source_path],
    )?;
    stage.db.execute(
        "INSERT OR IGNORE INTO attachments VALUES(?1,?2)",
        params![
            hash,
            serde_json::to_string(&entry).map_err(|_| format::invalid())?
        ],
    )?;
    stage
        .db
        .execute(
            "INSERT INTO metadata VALUES(?1,?2)",
            params![format!("json-asset:{id}"), hash],
        )
        .map_err(|_| format::invalid())?;
    Ok(())
}

fn add_note(
    stage: &Stage,
    raw: &Value,
    folders: &[Value],
    cancel: &CancellationToken,
) -> Result<(), Error> {
    cancel.check()?;
    let note: crate::Note = serde_json::from_value(raw.clone()).map_err(|_| format::invalid())?;
    let mut parent = note.summary.folder_id.as_ref().map(|v| v.to_string());
    let mut names = Vec::new();
    while let Some(id) = parent {
        if names.len() >= 12 {
            return Err(format::invalid());
        }
        let folder = folders
            .iter()
            .find(|f| f.get("id").and_then(Value::as_str) == Some(&id))
            .ok_or_else(format::invalid)?;
        names.push(
            folder
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(format::invalid)?
                .to_owned(),
        );
        parent = folder
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    names.reverse();
    let s = note.summary;
    let mut content = note.content;
    for id in export::attachment_ids(&content) {
        let hash: Option<String> = stage
            .db
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                [format!("json-asset:{id}")],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(hash) = hash {
            content = content.replace(
                &format!("/api/files/{id}"),
                &format!("autonote-import-hash:{hash}"),
            );
        }
    }
    let plan = PlanNote {
        id: s.id.to_string(),
        title: s.title,
        content,
        folder: names,
        created_at: s.created_at.get(),
        updated_at: s.updated_at.get(),
        deleted_at: s.deleted_at.map(|v| v.get()),
        is_archived: s.is_archived,
        is_starred: s.is_starred,
        is_pinned: s.is_pinned,
    };
    format::validate_plan(&plan)?;
    stage
        .db
        .execute(
            "INSERT INTO notes VALUES(?1,?2)",
            params![
                plan.id,
                serde_json::to_string(&plan).map_err(|_| format::invalid())?
            ],
        )
        .map_err(|_| format::invalid())?;
    Ok(())
}
