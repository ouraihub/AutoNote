use super::super::format::{self, AttachmentEntry, PlanNote};
use super::super::stage::Stage;
use super::super::{
    CancellationToken, ImportConflict, ImportResult, ProgressSink, TransferService,
};
use super::publish::merge_folder;
use super::relative_url;
use crate::write::WriteTx;
use crate::{Error, ProgressPhase};
use rusqlite::{OptionalExtension, params};
pub(super) struct ImportOptions {
    pub conflict: ImportConflict,
    pub backup: bool,
}

pub(super) fn write(
    w: &mut WriteTx<'_>,
    stage: &Stage,
    service: &TransferService,
    options: ImportOptions,
    progress: &dyn ProgressSink,
    cancel: &CancellationToken,
    result: &mut ImportResult,
) -> Result<(), Error> {
    let ImportOptions { conflict, backup } = options;
    let mut count = 0;
    let mut notes = stage.db.prepare("SELECT id,data FROM notes ORDER BY id")?;
    for raw in notes.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        cancel.check()?;
        let (source, data) = raw?;
        let mut note: PlanNote = serde_json::from_str(&data).map_err(|_| format::invalid())?;
        let id: String = stage.db.query_row(
            "SELECT target FROM mappings WHERE source=?1",
            [&source],
            |r| r.get(0),
        )?;
        if id.is_empty() {
            result.skipped_notes += 1;
            continue;
        }
        let note_path: String = stage
            .db
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                [format!("path:{source}")],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_default();
        if backup {
            // Backup rendering rewrites logical attachment URLs even in code;
            // undo that exact format transform before the Obsidian-safe scanner.
            let mut assets = stage
                .db
                .prepare("SELECT data FROM attachments ORDER BY hash")?;
            for raw in assets.query_map([], |r| r.get::<_, String>(0))? {
                cancel.check()?;
                let entry: AttachmentEntry =
                    serde_json::from_str(&raw?).map_err(|_| format::invalid())?;
                let target: String = stage.db.query_row(
                    "SELECT target FROM mappings WHERE source=?1",
                    [format!("hash:{}", entry.sha256)],
                    |r| r.get(0),
                )?;
                note.content = note.content.replace(
                    &relative_url(&note_path, &entry.path),
                    &format!("/api/files/{target}"),
                );
            }
        }
        note.content = super::super::obsidian::rewrite_links(
            &note.content,
            |reference, _asset| {
                if let Some(asset) = reference.strip_prefix("autonote-import-hash:") {
                    let (hash, fragment) = asset
                        .split_once('#')
                        .map_or((asset, ""), |(hash, part)| (hash, part));
                    if !format::hash_valid(hash) {
                        return Err(format::invalid());
                    }
                    let target: String = stage.db.query_row(
                        "SELECT target FROM mappings WHERE source=?1",
                        [format!("hash:{hash}")],
                        |r| r.get(0),
                    )?;
                    return Ok(Some(format!(
                        "/api/files/{target}{}",
                        if fragment.is_empty() {
                            String::new()
                        } else {
                            format!("#{fragment}")
                        }
                    )));
                }
                if matches!(conflict, ImportConflict::Duplicate)
                    && let Some(link) = reference.strip_prefix("/notes/")
                {
                    let (from, fragment) = link
                        .split_once('#')
                        .map_or((link, ""), |(id, part)| (id, part));
                    let target: Option<String> = stage
                        .db
                        .query_row("SELECT target FROM mappings WHERE source=?1", [from], |r| {
                            r.get(0)
                        })
                        .optional()?;
                    if let Some(target) = target.filter(|id| !id.is_empty()) {
                        return Ok(Some(format!(
                            "/notes/{target}{}",
                            if fragment.is_empty() {
                                String::new()
                            } else {
                                format!("#{fragment}")
                            }
                        )));
                    }
                }
                Ok(None)
            },
            false,
        )?;
        format::validate_plan(&note)?;
        let folder = merge_folder(w, &note.folder, result)?;
        let old: Option<(String, String, i64, i64)> =
            w.tx.query_row(
                "SELECT title,content,rev,updated_at FROM notes WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let rev = old.as_ref().map_or(1, |v| v.2 + 1);
        crate::Rev::new(rev)?;
        let now = note
            .updated_at
            .max(w.now.get())
            .max(old.as_ref().map_or(0, |v| v.3.saturating_add(1)));
        format::timestamp(now)?;
        if let Some((title, content, _, _)) = &old {
            let version = w.id()?;
            crate::write::versions::snapshot(
                &w.tx,
                &id,
                title,
                content,
                &version,
                crate::Millis::new(now)?,
            )?;
            result.updated_notes += 1;
        } else {
            result.created_notes += 1;
        }
        let (words, chars) = crate::markdown::count_text(&note.content);
        w.tx.execute(
            "INSERT INTO notes(id,folder_id,title,content,excerpt,rev,word_count,char_count,\
             is_starred,is_pinned,is_archived,position,content_hash,created_at,updated_at,\
             deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13,?14,?15) \
             ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,\
             content=excluded.content,excerpt=excluded.excerpt,rev=excluded.rev,\
             word_count=excluded.word_count,char_count=excluded.char_count,\
             is_starred=excluded.is_starred,is_pinned=excluded.is_pinned,\
             is_archived=excluded.is_archived,content_hash=excluded.content_hash,\
             updated_at=excluded.updated_at,deleted_at=excluded.deleted_at",
            params![
                id,
                folder,
                note.title,
                note.content,
                crate::markdown::derive_excerpt(&note.content, 220),
                rev,
                words as i64,
                chars as i64,
                note.is_starred,
                note.is_pinned,
                note.is_archived,
                crate::markdown::sha256_hex(&note.content),
                note.created_at,
                now,
                note.deleted_at
            ],
        )?;
        let old_key = old
            .as_ref()
            .map(|v| crate::markdown::normalize_link_key(&v.0));
        crate::write::derived::derive(
            &w.tx,
            w.ids.as_ref(),
            &id,
            &note.title,
            &note.content,
            note.deleted_at.is_some(),
            w.now,
            old_key.as_deref(),
        )?;
        w.record_change(&id, "upsert")?;
        w.changes.import_changed = true;
        count += 1;
        service.progress(progress, ProgressPhase::Writing, count);
    }
    Ok(())
}
