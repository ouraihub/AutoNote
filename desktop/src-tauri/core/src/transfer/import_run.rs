use super::import::*;
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
            for tag in tags { let name=crate::markdown::normalize_link_key(&tag.name);if name.is_empty()||name.encode_utf16().count()>60{return Err(format::invalid())}let exists:bool=w.tx.query_row("SELECT EXISTS(SELECT 1 FROM tags WHERE name=?1)",[&name],|r|r.get(0))?;if !exists {let id=w.id()?;w.tx.execute("INSERT INTO tags(id,name,color,is_manual,created_at) VALUES(?1,?2,?3,1,?4)",params![id,name,tag.color,tag.created_at.get()])?;w.tx.execute("INSERT INTO changes(entity,entity_id,op,at) VALUES('tag',?1,'upsert',?2)",params![id,w.now.get()])?;w.mark(crate::write::DirtyEntity::Tag,&id);}}
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
