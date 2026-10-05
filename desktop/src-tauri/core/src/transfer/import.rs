use super::format::{self, AttachmentEntry, NoteEntry, PlanNote};
use super::stage::Stage;
use super::{
    AuthorizedInput, CancellationToken, ImportConflict, ImportResult, ProgressSink, TransferService,
};
use crate::{Error, ProgressPhase, WriteOrigin};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

pub(super) fn run(
    service: &TransferService,
    input: AuthorizedInput,
    conflict: ImportConflict,
    progress: &dyn ProgressSink,
    cancel: &CancellationToken,
) -> Result<ImportResult, Error> {
    cancel.check()?;
    let stage = Stage::new(service)?;
    service.progress(progress, ProgressPhase::Reading, 0);
    stage.ingest(input, service, progress, cancel)?;
    service.progress(progress, ProgressPhase::Validating, 0);
    let backup = format::select_backup(&stage, cancel)?;
    if let Some((root, _)) = &backup {
        stage
            .db
            .execute("INSERT INTO metadata VALUES('root',?1)", [root])?;
        let mut after = String::new();
        let mut count = 0;
        loop {
            let next: Option<(String, String)> = stage
                .db
                .query_row(
                    "SELECT id,data FROM notes WHERE id>?1 ORDER BY id LIMIT 1",
                    [&after],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((id, raw)) = next else { break };
            cancel.check()?;
            let entry: NoteEntry = serde_json::from_str(&raw).map_err(|_| format::invalid())?;
            let content = format::read_text(
                stage.entry(&format!("{root}{}", entry.path))?.0,
                format::CONTENT_MAX as u64,
            )?;
            validate_backup_links(&stage, &entry, &content, cancel)?;
            stage.db.execute(
                "INSERT INTO metadata VALUES(?1,?2)",
                params![format!("path:{id}"), entry.path],
            )?;
            let note = PlanNote {
                id: id.clone(),
                title: entry.title,
                content,
                folder: entry.folder,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
                deleted_at: entry.deleted_at,
                is_archived: entry.archived,
                is_starred: false,
                is_pinned: false,
            };
            format::validate_plan(&note)?;
            stage.db.execute(
                "UPDATE notes SET data=?1 WHERE id=?2",
                params![
                    serde_json::to_string(&note).map_err(|_| format::invalid())?,
                    id
                ],
            )?;
            after = id;
            count += 1;
            service.progress(progress, ProgressPhase::Validating, count);
        }
    } else {
        let mut candidates = stage.db.prepare("SELECT path FROM entries WHERE lower(path) LIKE '%.json' AND path NOT LIKE '.obsidian/%' ORDER BY path")?;
        let mut selected = None;
        for raw in candidates.query_map([], |r| r.get::<_, String>(0))? {
            cancel.check()?;
            let path = raw?;
            let (_, size, _) = stage.entry(&path)?;
            if size > format::BUNDLE_MAX {
                return Err(Error::TooLarge {
                    field: "source",
                    limit: format::BUNDLE_MAX,
                });
            }
            let body = format::read_text(stage.entry(&path)?.0, format::BUNDLE_MAX)?;
            let parsed = serde_json::from_str::<Value>(&body);
            if path
                .rsplit('/')
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("autonote-export.json"))
                || parsed.as_ref().is_ok_and(|v| v.get("format").is_some())
            {
                let bundle = parsed.map_err(|_| format::invalid())?;
                if bundle.get("format").and_then(Value::as_str) != Some("autonote-export")
                    || selected.is_some()
                {
                    return Err(format::invalid());
                }
                let prefix = path.rsplit_once('/').map_or("", |(dir, _)| dir);
                stage
                    .db
                    .execute("INSERT INTO metadata VALUES('bundle-prefix',?1)", [prefix])?;
                selected = Some(bundle);
            }
        }
        drop(candidates);
        if let Some(bundle) = selected {
            json_plan(&stage, &bundle, cancel)?;
        } else {
            super::obsidian::plan(&stage, service, progress, cancel)?;
        }
    }
    let mut result = ImportResult::default();
    let mut warnings = stage.db.prepare("SELECT message FROM warnings LIMIT 100")?;
    for raw in warnings.query_map([], |r| r.get::<_, String>(0))? {
        result.warnings.push(raw?);
    }
    drop(warnings);
    let warning_count: u64 = u64::try_from(stage.db.query_row(
        "SELECT COUNT(*) FROM warnings",
        [],
        |r| r.get::<_, i64>(0),
    )?)
    .map_err(|_| Error::invalid("count", "must be a non-negative integer"))?;
    if warning_count > 100 {
        result.warnings.truncate(99);
        result.warnings.push(format!(
            "{} additional warnings omitted",
            warning_count - 99
        ));
    }
    let staged: u64 = u64::try_from(stage.db.query_row(
        "SELECT COALESCE(SUM(size),0) FROM entries",
        [],
        |r| r.get::<_, i64>(0),
    )?)
    .map_err(|_| Error::invalid("size", "must be a non-negative integer"))?;
    let growth = staged.saturating_mul(2).saturating_add(8 * 1024 * 1024);
    if fs2::available_space(stage.directory.path())? < growth {
        return Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into());
    }
    stage.phase("validated")?;
    #[cfg(test)]
    crash_point("validated");
    // The same guard used by uploads/prune pins every newly published object
    // until the single domain commit has either succeeded or rolled back.
    let written=service.library.files.transfer_guard(|| {
        let transaction = service.library.write(WriteOrigin::Import,|w| {
        cancel.check()?;
        stage.phase("publishing")?;
        if let Some(raw)=stage.db.query_row("SELECT value FROM metadata WHERE key='json-folders'",[],|r|r.get::<_,String>(0)).optional()? {
            let folders:Vec<crate::Folder>=serde_json::from_str(&raw).map_err(|_|format::invalid())?;
            for folder in &folders { let mut names=Vec::new();let mut current=Some(folder.id.to_string());while let Some(id)=current {if names.len()>=12{return Err(format::invalid())}let f=folders.iter().find(|f|f.id.as_str()==id).ok_or_else(format::invalid)?;names.push(f.name.clone());current=f.parent_id.as_ref().map(|v|v.to_string());}names.reverse();merge_folder(w,&names,&mut result)?; }
        }
        if let Some(raw)=stage.db.query_row("SELECT value FROM metadata WHERE key='json-tags'",[],|r|r.get::<_,String>(0)).optional()? {
            let tags:Vec<crate::Tag>=serde_json::from_str(&raw).map_err(|_|format::invalid())?;
            for tag in tags { let name=crate::markdown::normalize_link_key(&tag.name);if name.is_empty()||name.encode_utf16().count()>60{return Err(format::invalid())}let exists:bool=w.tx.query_row("SELECT EXISTS(SELECT 1 FROM tags WHERE name=?1)",[&name],|r|r.get(0))?;if !exists {let id=w.id()?;w.tx.execute("INSERT INTO tags(id,name,color,is_manual,created_at) VALUES(?1,?2,?3,1,?4)",params![id,name,tag.color,tag.created_at.get()])?;w.tx.execute("INSERT INTO changes(entity,entity_id,op,at) VALUES('tag',?1,'upsert',?2)",params![id,w.now.get()])?;w.changes.tags_changed=true;}}
        }
        stage.db.execute_batch("DELETE FROM mappings;")?;
        let mut stmt=stage.db.prepare("SELECT id,data FROM notes ORDER BY id")?;
        for raw in stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
            cancel.check()?; let (id,data)=raw?; let note:PlanNote=serde_json::from_str(&data).map_err(|_|format::invalid())?;
            let old:Option<i64>=w.tx.query_row("SELECT updated_at FROM notes WHERE id=?1",[&id],|r|r.get(0)).optional()?;
            let target=if matches!(conflict,ImportConflict::Duplicate) { w.id()? } else { id.clone() };
            let skip=old.is_some() && (matches!(conflict,ImportConflict::Skip) || (matches!(conflict,ImportConflict::Newer) && old.is_some_and(|at|at>=note.updated_at)));
            stage.db.execute("INSERT INTO mappings VALUES(?1,?2)",params![id,if skip {String::new()} else {target}])?;
        }
        drop(stmt);
        let root:String=stage.db.query_row("SELECT value FROM metadata WHERE key='root'",[],|r|r.get(0)).optional()?.unwrap_or_default();
        let mut attachments=stage.db.prepare("SELECT data FROM attachments ORDER BY hash")?;
        let mut used:i64=w.tx.query_row("SELECT COALESCE(SUM(size),0) FROM attachments",[],|r|r.get(0))?;
        for raw in attachments.query_map([],|r|r.get::<_,String>(0))? {
            cancel.check()?; let entry:AttachmentEntry=serde_json::from_str(&raw?).map_err(|_|format::invalid())?;
            let size = super::stage::Stage::sql_size(entry.size)?;
            let found:Option<String>=w.tx.query_row("SELECT id FROM attachments WHERE sha256=?1 AND size=?2 ORDER BY id LIMIT 1",params![entry.sha256,size],|r|r.get(0)).optional()?;
            let id=if let Some(id)=found {
                let hash=super::export::hash_file(std::fs::File::open(service.library.files.transfer_root().join(&id))?,cancel)?;
                if hash!=entry.sha256 { return Err(format::invalid()) } result.skipped_attachments+=1; id
            } else {
                used=used.checked_add(size).ok_or_else(format::invalid)?;
                if used>1024*1024*1024 {return Err(Error::TooLarge {field:"source",limit:1024*1024*1024})}
                let mut id=w.id()?;
                for _ in 0..8 { if !service.library.files.transfer_root().join(&id).exists() {break} id=w.id()?; }
                let destination=service.library.files.transfer_root().join(&id);
                if destination.exists() {return Err(format::invalid())}
                let (input,_,_)=stage.entry(&format!("{root}{}",entry.path))?;
                let input_object:String=stage.db.query_row("SELECT object FROM entries WHERE path=?1",[format!("{root}{}",entry.path)],|r|r.get(0))?; drop(input);
                // The durable journal precedes rename, so recovery knows every new object.
                stage.db.execute("INSERT INTO published VALUES(?1,?2)", params![id,entry.sha256])?;
                std::fs::rename(stage.object(&input_object),&destination)?;
                #[cfg(test)]
                crash_point("renamed");
                let hash=super::export::hash_file(std::fs::File::open(&destination)?,cancel)?;
                if hash!=entry.sha256 { return Err(format::invalid()) }
                w.tx.execute("INSERT INTO attachments(id,filename,mime,size,sha256,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![id,entry.filename,entry.mime,size,entry.sha256,entry.created_at])?;
                result.created_attachments+=1;id
            };
            stage.db.execute("INSERT INTO mappings VALUES(?1,?2)",params![format!("hash:{}",entry.sha256),id])?;
        }
        let mut count=0;
        let mut notes=stage.db.prepare("SELECT id,data FROM notes ORDER BY id")?;
        for raw in notes.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
            cancel.check()?;let (source,data)=raw?;let mut note:PlanNote=serde_json::from_str(&data).map_err(|_|format::invalid())?;
            let id:String=stage.db.query_row("SELECT target FROM mappings WHERE source=?1",[&source],|r|r.get(0))?;
            if id.is_empty() {result.skipped_notes+=1;continue}
            let note_path: String = stage.db.query_row("SELECT value FROM metadata WHERE key=?1", [format!("path:{source}")], |r|r.get(0)).optional()?.unwrap_or_default();
            if backup.is_some() {
                // Backup rendering rewrites logical attachment URLs even in code;
                // undo that exact format transform before the Obsidian-safe scanner.
                let mut assets = stage.db.prepare("SELECT data FROM attachments ORDER BY hash")?;
                for raw in assets.query_map([],|r|r.get::<_,String>(0))? {
                    cancel.check()?;
                    let entry: AttachmentEntry = serde_json::from_str(&raw?).map_err(|_|format::invalid())?;
                    let target: String = stage.db.query_row("SELECT target FROM mappings WHERE source=?1", [format!("hash:{}",entry.sha256)], |r|r.get(0))?;
                    note.content = note.content.replace(&relative_url(&note_path, &entry.path), &format!("/api/files/{target}"));
                }
            }
            note.content = super::obsidian::rewrite_links(&note.content, |reference, _asset| {
                if let Some(asset) = reference.strip_prefix("autonote-import-hash:") {
                    let (hash, fragment) = asset.split_once('#').map_or((asset,""),|(hash,part)|(hash,part));
                    if !format::hash_valid(hash) { return Err(format::invalid()) }
                    let target: String = stage.db.query_row("SELECT target FROM mappings WHERE source=?1", [format!("hash:{hash}")], |r|r.get(0))?;
                    return Ok(Some(format!("/api/files/{target}{}",if fragment.is_empty(){String::new()}else{format!("#{fragment}")})));
                }
                if matches!(conflict,ImportConflict::Duplicate) && let Some(link) = reference.strip_prefix("/notes/") {
                    let (from, fragment) = link.split_once('#').map_or((link,""),|(id,part)|(id,part));
                    let target: Option<String> = stage.db.query_row("SELECT target FROM mappings WHERE source=?1", [from], |r|r.get(0)).optional()?;
                    if let Some(target) = target.filter(|id| !id.is_empty()) { return Ok(Some(format!("/notes/{target}{}", if fragment.is_empty() {String::new()} else {format!("#{fragment}")}))) }
                }
                Ok(None)
            }, false)?;
            format::validate_plan(&note)?;
            let folder=merge_folder(w,&note.folder,&mut result)?;
            let old:Option<(String,String,i64,i64)>=w.tx.query_row("SELECT title,content,rev,updated_at FROM notes WHERE id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            let rev=old.as_ref().map_or(1,|v|v.2+1);crate::Rev::new(rev)?;
            let now=note.updated_at.max(w.now.get()).max(old.as_ref().map_or(0,|v|v.3.saturating_add(1)));
            format::timestamp(now)?;
            if let Some((title,content,_,_))=&old {
                let version=w.id()?;crate::write::versions::snapshot(&w.tx,&id,title,content,&version,crate::Millis::new(now)?)?;result.updated_notes+=1;
            } else {result.created_notes+=1;}
            let (words,chars)=crate::markdown::count_text(&note.content);
            w.tx.execute("INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,is_starred,is_pinned,is_archived,position,content_hash,created_at,updated_at,deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13,?14,?15) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,content=excluded.content,excerpt=excluded.excerpt,rev=excluded.rev,word_count=excluded.word_count,char_count=excluded.char_count,is_starred=excluded.is_starred,is_pinned=excluded.is_pinned,is_archived=excluded.is_archived,content_hash=excluded.content_hash,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at",params![id,folder,note.title,note.content,crate::markdown::derive_excerpt(&note.content,220),rev,words as i64,chars as i64,note.is_starred,note.is_pinned,note.is_archived,crate::markdown::sha256_hex(&note.content),note.created_at,now,note.deleted_at])?;
            let old_key=old.as_ref().map(|v|crate::markdown::normalize_link_key(&v.0));
            crate::write::derived::derive(&w.tx,w.ids.as_ref(),&id,&note.title,&note.content,note.deleted_at.is_some(),w.now,old_key.as_deref())?;
            w.record_change(&id,"upsert")?;
            w.changes.import_changed = true;
            count+=1;service.progress(progress,ProgressPhase::Writing,count);
        }
        // app_meta is already a committed, durable marker namespace; no schema
        // version is needed and crash recovery trusts committed object references.
        w.tx.execute("INSERT OR REPLACE INTO app_meta VALUES(?1,'committed')",[format!("import:{}",service.job_id)])?;
        #[cfg(test)]
        crash_point("before-commit");
        cancel.committing()?;service.progress(progress,ProgressPhase::Finalizing,0);
        Ok(())
        });
        stage.cleanup_published(&service.library)?;
        transaction
    });
    if let Err(error) = written {
        // Preserve the journal only if reference-aware cleanup itself failed.
        if stage.cleanup_published(&service.library).is_err() {
            drop(stage.db);
            let _preserved = stage.directory.keep();
        }
        return Err(error);
    }
    #[cfg(test)]
    crash_point("committed");
    stage.phase("committed")?;
    service.library.read(|conn| {
        conn.execute(
            "DELETE FROM app_meta WHERE key=?1",
            [format!("import:{}", service.job_id)],
        )?;
        Ok(())
    })?;
    Ok(result)
}
#[cfg(test)]
fn crash_point(point: &str) {
    if std::env::var("AUTONOTE_TRANSFER_CRASH").as_deref() == Ok(point) {
        std::process::exit(86);
    }
}
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
            w.changes.folders_changed = true;
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
