use super::super::format::{self, AttachmentEntry, PlanNote};
use super::super::stage::Stage;
use super::super::{CancellationToken, ImportConflict, ImportResult, TransferService};
use crate::Error;
use crate::write::WriteTx;
use rusqlite::{OptionalExtension, params};

pub(super) fn organizers(
    w: &mut WriteTx<'_>,
    stage: &Stage,
    result: &mut ImportResult,
) -> Result<(), Error> {
    if let Some(raw) = stage
        .db
        .query_row(
            "SELECT value FROM metadata WHERE key='json-folders'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        let folders: Vec<crate::Folder> =
            serde_json::from_str(&raw).map_err(|_| format::invalid())?;
        for folder in &folders {
            let mut names = Vec::new();
            let mut current = Some(folder.id.to_string());
            while let Some(id) = current {
                if names.len() >= 12 {
                    return Err(format::invalid());
                }
                let found = folders
                    .iter()
                    .find(|f| f.id.as_str() == id)
                    .ok_or_else(format::invalid)?;
                names.push(found.name.clone());
                current = found.parent_id.as_ref().map(|v| v.to_string());
            }
            names.reverse();
            merge_folder(w, &names, result)?;
        }
    }
    if let Some(raw) = stage
        .db
        .query_row(
            "SELECT value FROM metadata WHERE key='json-tags'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        let tags: Vec<crate::Tag> = serde_json::from_str(&raw).map_err(|_| format::invalid())?;
        for tag in tags {
            let name = crate::markdown::normalize_link_key(&tag.name);
            if name.is_empty() || name.encode_utf16().count() > 60 {
                return Err(format::invalid());
            }
            let exists: bool = w.tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM tags WHERE name=?1)",
                [&name],
                |r| r.get(0),
            )?;
            if !exists {
                let id = w.id()?;
                w.tx.execute(
                    "INSERT INTO tags(id,name,color,is_manual,created_at) VALUES(?1,?2,?3,1,?4)",
                    params![id, name, tag.color, tag.created_at.get()],
                )?;
                w.tx.execute(
                    "INSERT INTO changes(entity,entity_id,op,at) VALUES('tag',?1,'upsert',?2)",
                    params![id, w.now.get()],
                )?;
                w.mark(crate::write::DirtyEntity::Tag, &id);
            }
        }
    }
    Ok(())
}

pub(super) fn mappings(
    w: &mut WriteTx<'_>,
    stage: &Stage,
    conflict: ImportConflict,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    stage.db.execute_batch("DELETE FROM mappings;")?;
    let mut stmt = stage.db.prepare("SELECT id,data FROM notes ORDER BY id")?;
    for raw in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        cancel.check()?;
        let (id, data) = raw?;
        let note: PlanNote = serde_json::from_str(&data).map_err(|_| format::invalid())?;
        let old: Option<i64> =
            w.tx.query_row("SELECT updated_at FROM notes WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .optional()?;
        let target = if matches!(conflict, ImportConflict::Duplicate) {
            w.id()?
        } else {
            id.clone()
        };
        let skip = old.is_some()
            && (matches!(conflict, ImportConflict::Skip)
                || (matches!(conflict, ImportConflict::Newer)
                    && old.is_some_and(|at| at >= note.updated_at)));
        stage.db.execute(
            "INSERT INTO mappings VALUES(?1,?2)",
            params![id, if skip { String::new() } else { target }],
        )?;
    }
    Ok(())
}

pub(super) fn attachments(
    w: &mut WriteTx<'_>,
    stage: &Stage,
    service: &TransferService,
    cancel: &CancellationToken,
    result: &mut ImportResult,
) -> Result<(), Error> {
    let root: String = stage
        .db
        .query_row("SELECT value FROM metadata WHERE key='root'", [], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or_default();
    let mut attachments = stage
        .db
        .prepare("SELECT data FROM attachments ORDER BY hash")?;
    let mut used: i64 =
        w.tx.query_row("SELECT COALESCE(SUM(size),0) FROM attachments", [], |r| {
            r.get(0)
        })?;
    for raw in attachments.query_map([], |r| r.get::<_, String>(0))? {
        cancel.check()?;
        let entry: AttachmentEntry = serde_json::from_str(&raw?).map_err(|_| format::invalid())?;
        let size = Stage::sql_size(entry.size)?;
        let found: Option<String> =
            w.tx.query_row(
                "SELECT id FROM attachments WHERE sha256=?1 AND size=?2 ORDER BY id LIMIT 1",
                params![entry.sha256, size],
                |r| r.get(0),
            )
            .optional()?;
        let id = if let Some(id) = found {
            let hash = super::super::export::hash_file(
                std::fs::File::open(service.library.files.transfer_root().join(&id))?,
                cancel,
            )?;
            if hash != entry.sha256 {
                return Err(format::invalid());
            }
            result.skipped_attachments += 1;
            id
        } else {
            used = used.checked_add(size).ok_or_else(format::invalid)?;
            if used > 1024 * 1024 * 1024 {
                return Err(Error::TooLarge {
                    field: "source",
                    limit: 1024 * 1024 * 1024,
                });
            }
            let mut id = w.id()?;
            for _ in 0..8 {
                if !service.library.files.transfer_root().join(&id).exists() {
                    break;
                }
                id = w.id()?;
            }
            let destination = service.library.files.transfer_root().join(&id);
            if destination.exists() {
                return Err(format::invalid());
            }
            let (input, _, _) = stage.entry(&format!("{root}{}", entry.path))?;
            let input_object: String = stage.db.query_row(
                "SELECT object FROM entries WHERE path=?1",
                [format!("{root}{}", entry.path)],
                |r| r.get(0),
            )?;
            drop(input);
            // The durable journal precedes rename, so recovery knows every new object.
            stage.db.execute(
                "INSERT INTO published VALUES(?1,?2)",
                params![id, entry.sha256],
            )?;
            std::fs::rename(stage.object(&input_object), &destination)?;
            #[cfg(test)]
            super::crash_point("renamed");
            let hash = super::super::export::hash_file(std::fs::File::open(&destination)?, cancel)?;
            if hash != entry.sha256 {
                return Err(format::invalid());
            }
            w.tx.execute(
                "INSERT INTO attachments(id,filename,mime,size,sha256,created_at) \
                 VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    id,
                    entry.filename,
                    entry.mime,
                    size,
                    entry.sha256,
                    entry.created_at
                ],
            )?;
            result.created_attachments += 1;
            id
        };
        stage.db.execute(
            "INSERT INTO mappings VALUES(?1,?2)",
            params![format!("hash:{}", entry.sha256), id],
        )?;
    }
    Ok(())
}

pub(super) fn merge_folder(
    w: &mut WriteTx<'_>,
    names: &[String],
    result: &mut ImportResult,
) -> Result<Option<String>, Error> {
    let mut parent: Option<String> = None;
    for name in names {
        let found: Option<String> =
            w.tx.query_row(
                "SELECT id FROM folders WHERE parent_id IS ?1 AND lower(name)=lower(?2) \
             AND deleted_at IS NULL",
                params![parent, name],
                |r| r.get(0),
            )
            .optional()?;
        let id = if let Some(id) = found {
            id
        } else {
            let id = w.id()?;
            w.tx.execute(
                "INSERT INTO folders(id,parent_id,name,created_at,updated_at) \
                 VALUES(?1,?2,?3,?4,?4)",
                params![id, parent, name, w.now.get()],
            )?;
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
