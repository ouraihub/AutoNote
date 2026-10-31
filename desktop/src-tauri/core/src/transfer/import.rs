use super::format::{self, AttachmentEntry, NoteEntry, PlanNote};
use super::stage::Stage;
use super::{
    AuthorizedInput, CancellationToken, ImportConflict, ImportResult, ProgressSink, TransferService,
};
use crate::{Error, ProgressPhase, WriteOrigin};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;
#[path = "import_run.rs"]
mod import_run;

fn validate_backup_links(
    stage: &Stage,
    note: &NoteEntry,
    content: &str,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    super::obsidian::rewrite_links(
        content,
        |reference, _| {
            cancel.check()?;
            if reference.starts_with("http:") || reference.starts_with("https:") {
                return Ok(None);
            }
            if reference.contains("attachments/") {
                let mut declared = false;
                for hash in &note.attachment_hashes {
                    let raw: String = stage.db.query_row(
                        "SELECT data FROM attachments WHERE hash=?1",
                        [hash],
                        |r| r.get(0),
                    )?;
                    let attachment: AttachmentEntry =
                        serde_json::from_str(&raw).map_err(|_| format::invalid())?;
                    if reference == relative_url(&note.path, &attachment.path) {
                        declared = true;
                        break;
                    }
                }
                if !declared {
                    return Err(format::invalid());
                }
            }
            Ok(None)
        },
        false,
    )?;
    Ok(())
}
fn merge_folder(
    w: &mut crate::write::WriteTx<'_>,
    names: &[String],
    result: &mut ImportResult,
) -> Result<Option<String>, Error> {
    let mut parent: Option<String> = None;
    for name in names {
        let found:Option<String>=w.tx.query_row("SELECT id FROM folders WHERE parent_id IS ?1 AND lower(name)=lower(?2) AND deleted_at IS NULL",params![parent,name],|r|r.get(0)).optional()?;
        let id = if let Some(id) = found {
            id
        } else {
            let id = w.id()?;
            w.tx.execute("INSERT INTO folders(id,parent_id,name,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",params![id,parent,name,w.now.get()])?;
            w.tx.execute(
                "INSERT INTO changes(entity,entity_id,op,at) VALUES('folder',?1,'upsert',?2)",
                params![id, w.now.get()],
            )?;
            w.mark(crate::write::DirtyEntity::Folder, &id);
            result.created_folders += 1;
            id
        };
        parent = Some(id);
    }
    Ok(parent)
}
fn json_plan(stage: &Stage, bundle: &Value, cancel: &CancellationToken) -> Result<(), Error> {
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
    let typed_folders: Vec<crate::Folder> =
        serde_json::from_value(Value::Array(folders.clone())).map_err(|_| format::invalid())?;
    let typed_tags: Vec<crate::Tag> =
        serde_json::from_value(Value::Array(tags.clone())).map_err(|_| format::invalid())?;
    let mut folder_ids = std::collections::HashSet::new();
    for folder in &typed_folders {
        format::folder_valid(std::slice::from_ref(&folder.name))?;
        format::timestamp(folder.created_at.get())?;
        format::timestamp(folder.updated_at.get())?;
        if !folder_ids.insert(folder.id.as_str()) || !folder.position.is_finite() {
            return Err(format::invalid());
        }
        let mut parent = folder.parent_id.as_ref();
        let mut depth = 1;
        while let Some(id) = parent {
            depth += 1;
            if depth > 12 {
                return Err(format::invalid());
            }
            parent = typed_folders
                .iter()
                .find(|f| &f.id == id)
                .ok_or_else(format::invalid)?
                .parent_id
                .as_ref();
        }
    }
    let mut tag_ids = std::collections::HashSet::new();
    for tag in &typed_tags {
        format::timestamp(tag.created_at.get())?;
        if !tag_ids.insert(tag.id.as_str())
            || tag.name.trim().is_empty()
            || tag.name.encode_utf16().count() > 60
        {
            return Err(format::invalid());
        }
    }
    stage.db.execute(
        "INSERT INTO metadata VALUES('json-folders',?1)",
        [serde_json::to_string(&typed_folders).map_err(|_| format::invalid())?],
    )?;
    stage.db.execute(
        "INSERT INTO metadata VALUES('json-tags',?1)",
        [serde_json::to_string(&typed_tags).map_err(|_| format::invalid())?],
    )?;
    for raw in attachments {
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
        let target = format!(
            "attachments/{hash}--{}",
            super::export::safe_segment(filename)
        );
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
        cancel.check()?;
        let note: crate::Note =
            serde_json::from_value(raw.clone()).map_err(|_| format::invalid())?;
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
            let name = folder
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(format::invalid)?;
            names.push(name.to_owned());
            parent = folder
                .get("parentId")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        names.reverse();
        let s = note.summary;
        let mut content = note.content;
        for id in super::export::attachment_ids(&content) {
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
    }
    Ok(())
}
fn relative_url(from: &str, to: &str) -> String {
    let from: Vec<_> = from.split('/').collect();
    let to: Vec<_> = to.split('/').collect();
    let mut common = 0;
    while common + 1 < from.len() && common < to.len() && from[common] == to[common] {
        common += 1
    }
    format!(
        "{}{}",
        "../".repeat(from.len() - 1 - common),
        super::export::url_path(&to[common..].join("/"))
    )
}
