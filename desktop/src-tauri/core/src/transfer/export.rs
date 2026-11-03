mod helpers;
use super::format::{self, AttachmentEntry, NoteEntry};
use super::stage::Stage;
use super::{
    AuthorizedOutput, CancellationToken, ExportFormat, ExportSummary, ProgressSink, TransferService,
};
use crate::{Error, ProgressPhase};
use helpers::{LimitedWriter, copy, folder_path, write_records, write_rows, zip_error};
pub(super) use helpers::{attachment_ids, hash_file, safe_segment, url_path};
use rusqlite::{Connection, params};
use serde_json::json;
use std::fs::File;
use std::io::Write;

pub(super) fn run(
    service: &TransferService,
    output: AuthorizedOutput,
    format: ExportFormat,
    progress: &dyn ProgressSink,
    cancel: &CancellationToken,
) -> Result<ExportSummary, Error> {
    cancel.check()?;
    let stage = Stage::new(service)?;
    service.progress(progress, ProgressPhase::Reading, 0);
    let snapshot_path = stage.directory.path().join("snapshot.sqlite");
    // A disk snapshot and same-volume hard links pin immutable attachment objects.
    // Binary verification/compression runs only after releasing both live locks.
    let reader = service.library.files.transfer_guard(|| {
        let reader = service.library.read(|conn| {
            if let Some(path) = conn.path().filter(|path| !path.is_empty()) {
                let reader =
                    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                reader.execute_batch("BEGIN; SELECT count(*) FROM notes;")?;
                Ok(reader)
            } else {
                // In-memory test libraries have no second read connection.
                let mut reader = Connection::open_in_memory()?;
                let backup = rusqlite::backup::Backup::new(conn, &mut reader)?;
                backup.run_to_completion(128, std::time::Duration::ZERO, None)?;
                drop(backup);
                Ok(reader)
            }
        })?;
        let mut stmt = reader.prepare(
            "SELECT DISTINCT a.id,a.filename,a.mime,a.size,a.sha256,a.created_at \
                 FROM attachments a JOIN notes n ON instr(n.content,'/api/files/'||a.id)>0 \
                 ORDER BY a.sha256,a.id",
        )?;
        for raw in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                u64::try_from(r.get::<_, i64>(3)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Integer,
                        Box::new(error),
                    )
                })?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })? {
            cancel.check()?;
            let (id, filename, mime, size, hash, created_at) = raw?;
            let path = format!("attachments/{hash}--{}", safe_segment(&filename));
            let exists: bool = stage.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM attachments WHERE hash=?1)",
                [&hash],
                |r| r.get(0),
            )?;
            let entry = AttachmentEntry {
                path: path.clone(),
                filename,
                mime,
                size,
                sha256: hash.clone(),
                created_at,
            };
            entry.validate()?;
            if !exists && matches!(format, ExportFormat::Zip) {
                let source = service.library.files.transfer_root().join(&id);
                if !std::fs::symlink_metadata(&source)?.file_type().is_file() {
                    return Err(format::invalid());
                }
                let object: String =
                    stage
                        .db
                        .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
                std::fs::hard_link(source, stage.object(&object))?;
                stage.db.execute(
                    "INSERT INTO entries VALUES(?1,?2,?3,?4)",
                    params![path, object, Stage::sql_size(size)?, hash],
                )?;
                stage.db.execute(
                    "INSERT INTO attachments VALUES(?1,?2)",
                    params![
                        hash,
                        serde_json::to_string(&entry).map_err(|_| format::invalid())?
                    ],
                )?;
            }
            let canonical: String = if matches!(format, ExportFormat::Zip) {
                let raw: String = stage.db.query_row(
                    "SELECT data FROM attachments WHERE hash=?1",
                    [&hash],
                    |r| r.get(0),
                )?;
                serde_json::from_str::<AttachmentEntry>(&raw)
                    .map_err(|_| format::invalid())?
                    .path
            } else {
                path
            };
            stage
                .db
                .execute("INSERT INTO mappings VALUES(?1,?2)", params![id, canonical])?;
        }
        drop(stmt);
        Ok(reader)
    })?;
    let mut snapshot = Connection::open(&snapshot_path)?;
    let backup = rusqlite::backup::Backup::new(&reader, &mut snapshot)?;
    loop {
        cancel.check()?;
        match backup.step(128)? {
            rusqlite::backup::StepResult::Done => break,
            rusqlite::backup::StepResult::More => (),
            _ => return Err(Error::invalid("format", "snapshot is unavailable")),
        }
    }
    drop(backup);
    drop(reader);
    let mut pinned = stage
        .db
        .prepare("SELECT data FROM attachments ORDER BY hash")?;
    for raw in pinned.query_map([], |r| r.get::<_, String>(0))? {
        cancel.check()?;
        let entry: AttachmentEntry = serde_json::from_str(&raw?).map_err(|_| format::invalid())?;
        let (file, size, _) = stage.entry(&entry.path)?;
        if file.metadata()?.len() != size || hash_file(file, cancel)? != entry.sha256 {
            return Err(format::invalid());
        }
        format::validate_attachment_file(stage.entry(&entry.path)?.0, &entry)?;
    }
    drop(pinned);
    let nonce: String = stage
        .db
        .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
    let (partial, mut file) = output.partial(&nonce)?;
    let result = (|| {
        let now = service.library.clock.now()?.get();
        let date = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(now) * 1_000_000)
            .map_err(|_| format::invalid())?;
        let stamp = date
            .format(&time::macros::format_description!(
                "[year][month][day]-[hour][minute][second]-[subsecond digits:3]"
            ))
            .map_err(|_| format::invalid())?;
        let mut count = 0u64;
        let mut stmt = snapshot.prepare(&format!(
            "SELECT {} FROM notes n ORDER BY n.id",
            crate::db::rows::NOTE_COLUMNS_FULL
        ))?;
        let rows = stmt.query_map([], crate::db::rows::note)?;
        match format {
            ExportFormat::Json => {
                let mut writer = LimitedWriter {
                    file: &mut file,
                    bytes: 0,
                    max: format::BUNDLE_MAX,
                };
                write!(
                    writer,
                    concat!(
                        "{{\"format\":\"autonote-export\",\"version\":1,",
                        "\"exportedAt\":{now},\"user\":{{\"login\":\"local\",",
                        "\"name\":\"\"}},\"folders\":[",
                    ),
                    now = now
                )?;
                write_rows(
                    &snapshot,
                    &format!(
                        "SELECT {} FROM folders f WHERE deleted_at IS NULL ORDER BY id",
                        crate::db::rows::FOLDER_COLUMNS
                    ),
                    crate::db::rows::folder,
                    &mut writer,
                )?;
                writer.write_all(b"],\"tags\":[")?;
                write_rows(
                    &snapshot,
                    concat!(
                        "SELECT t.id,t.name,t.color,t.created_at,",
                        "(SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id=nt.note_id ",
                        "WHERE nt.tag_id=t.id AND n.deleted_at IS NULL) ",
                        "FROM tags t ORDER BY t.id",
                    ),
                    crate::db::rows::tag,
                    &mut writer,
                )?;
                writer.write_all(b"],\"notes\":[")?;
                for raw in rows {
                    cancel.check()?;
                    let note = raw?;
                    if note.content.len() > format::CONTENT_MAX
                        || note.summary.title.encode_utf16().count() > 512
                    {
                        return Err(format::invalid());
                    }
                    if count > 0 {
                        writer.write_all(b",")?;
                    }
                    serde_json::to_writer(&mut writer, &note)
                        .map_err(|e| Error::Io(std::io::Error::other(e)))?;
                    count += 1;
                    service.progress(progress, ProgressPhase::Writing, count);
                }
                writer.write_all(b"],\"attachments\":[]}")?;
            }
            ExportFormat::Zip => {
                let mut zip = zip::ZipWriter::new(&mut file);
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);
                for raw in rows {
                    cancel.check()?;
                    let note = raw?;
                    let s = &note.summary;
                    if note.content.len() > format::CONTENT_MAX {
                        return Err(format::invalid());
                    }
                    let folder = folder_path(&snapshot, s.folder_id.as_ref().map(|v| v.as_str()))?;
                    let state = if s.deleted_at.is_some() {
                        "trash"
                    } else if s.is_archived {
                        "archived"
                    } else {
                        "notes"
                    };
                    let path = format!("{state}/{}.md", s.id);
                    let mut content = note.content;
                    let mut hashes = Vec::new();
                    let ids = attachment_ids(&content);
                    for id in ids {
                        let target: String = stage
                            .db
                            .query_row("SELECT target FROM mappings WHERE source=?1", [&id], |r| {
                                r.get(0)
                            })
                            .map_err(|_| format::invalid())?;
                        let hash = target
                            .strip_prefix("attachments/")
                            .and_then(|v| v.split_once("--"))
                            .ok_or_else(format::invalid)?
                            .0
                            .to_owned();
                        if !hashes.contains(&hash) {
                            hashes.push(hash)
                        }
                        content = content.replace(
                            &format!("/api/files/{id}"),
                            &format!("../{}", url_path(&target)),
                        );
                    }
                    hashes.sort();
                    let entry = NoteEntry {
                        id: s.id.to_string(),
                        path: path.clone(),
                        title: s.title.clone(),
                        folder,
                        attachment_hashes: hashes,
                        state: state.to_owned(),
                        archived: s.is_archived,
                        bytes: content.len() as u64,
                        sha256: crate::markdown::sha256_hex(&content),
                        created_at: s.created_at.get(),
                        updated_at: s.updated_at.get(),
                        deleted_at: s.deleted_at.map(|v| v.get()),
                    };
                    stage.db.execute(
                        "INSERT INTO notes VALUES(?1,?2)",
                        params![
                            entry.id,
                            serde_json::to_string(&entry).map_err(|_| format::invalid())?
                        ],
                    )?;
                    zip.start_file(path, options).map_err(zip_error)?;
                    zip.write_all(content.as_bytes())?;
                    count += 1;
                    service.progress(progress, ProgressPhase::Writing, count);
                }
                let mut att = stage
                    .db
                    .prepare("SELECT data FROM attachments ORDER BY hash")?;
                for raw in att.query_map([], |r| r.get::<_, String>(0))? {
                    let entry: AttachmentEntry =
                        serde_json::from_str(&raw?).map_err(|_| format::invalid())?;
                    zip.start_file(&entry.path, options).map_err(zip_error)?;
                    copy(&mut stage.entry(&entry.path)?.0, &mut zip, cancel)?;
                }
                // Stream manifest from the disk index; neither note bodies nor manifest
                // records grow a whole-library Vec.
                let manifest_path = stage.directory.path().join("manifest-output.json");
                let mut manifest = File::create(&manifest_path)?;
                let header = json!({
                    "format": format::BACKUP_FORMAT,
                    "version": 3,
                    "appVersion": env!("CARGO_PKG_VERSION"),
                    "createdAt": date.format(&time::format_description::well_known::Rfc3339)
                        .map_err(|_| format::invalid())?,
                    "snapshot": stamp,
                });
                let header = serde_json::to_string(&header).map_err(|_| format::invalid())?;
                manifest.write_all(header.trim_end_matches('}').as_bytes())?;
                manifest.write_all(b",\"notes\":[")?;
                write_records(&stage.db, "notes", &mut manifest, cancel)?;
                manifest.write_all(b"],\"attachments\":[")?;
                write_records(&stage.db, "attachments", &mut manifest, cancel)?;
                manifest.write_all(b"]}")?;
                manifest.sync_all()?;
                drop(manifest);
                let hash = hash_file(File::open(&manifest_path)?, cancel)?;
                zip.start_file("manifest.json", options)
                    .map_err(zip_error)?;
                copy(&mut File::open(&manifest_path)?, &mut zip, cancel)?;
                zip.start_file("COMPLETE", options).map_err(zip_error)?;
                write!(
                    zip,
                    "{} v3\nmanifest-sha256 {hash}\n",
                    format::BACKUP_FORMAT
                )?;
                zip.finish().map_err(zip_error)?;
            }
        }
        file.flush()?;
        file.sync_all()?;
        let bytes = file.metadata()?.len();
        drop(file);
        let attachment_count = if matches!(format, ExportFormat::Zip) {
            u64::try_from(
                stage
                    .db
                    .query_row("SELECT COUNT(*) FROM attachments", [], |r| {
                        r.get::<_, i64>(0)
                    })?,
            )
            .map_err(|_| Error::invalid("count", "exceeds supported range"))?
        } else {
            0
        };
        cancel.committing()?;
        service.progress(progress, ProgressPhase::Finalizing, 0);
        output.publish(&partial)?;
        Ok(ExportSummary {
            format,
            note_count: count,
            attachment_count,
            bytes,
        })
    })();
    if result.is_err() {
        output.remove(&partial)?;
    }
    result
}
