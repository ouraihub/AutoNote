mod json;
mod notes;
mod publish;

use super::format::{self, AttachmentEntry, NoteEntry, PlanNote};
use super::stage::Stage;
use super::{
    AuthorizedInput, CancellationToken, ImportConflict, ImportResult, ProgressSink, TransferService,
};
use crate::{Error, ProgressPhase, WriteOrigin};
use json::plan as json_plan;
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
        let mut candidates = stage.db.prepare(concat!(
            "SELECT path FROM entries WHERE lower(path) LIKE '%.json' ",
            "AND path NOT LIKE '.obsidian/%' ORDER BY path",
        ))?;
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
    let written = service.library.files.transfer_guard(|| {
        let transaction = service.library.write(WriteOrigin::Import, |w| {
            cancel.check()?;
            stage.phase("publishing")?;
            publish::organizers(w, &stage, &mut result)?;
            publish::mappings(w, &stage, conflict, cancel)?;
            publish::attachments(w, &stage, service, cancel, &mut result)?;
            notes::write(
                w,
                &stage,
                service,
                notes::ImportOptions {
                    conflict,
                    backup: backup.is_some(),
                },
                progress,
                cancel,
                &mut result,
            )?;
            // app_meta is already a committed, durable marker namespace; no schema
            // version is needed and crash recovery trusts committed object references.
            w.tx.execute(
                "INSERT OR REPLACE INTO app_meta VALUES(?1,'committed')",
                [format!("import:{}", service.job_id)],
            )?;
            #[cfg(test)]
            crash_point("before-commit");
            cancel.committing()?;
            service.progress(progress, ProgressPhase::Finalizing, 0);
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
