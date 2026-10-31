use super::format::*;
use super::stage::Stage;
use super::CancellationToken;
use std::io::BufReader;
use rusqlite::params;
/// Returns a root prefix and selected manifest. Control files never downgrade to loose Markdown.
pub(super) fn select_backup(
    stage: &Stage,
    cancel: &CancellationToken,
) -> Result<Option<(String, String)>, Error> {
    let mut stmt = stage.db.prepare(
        "SELECT path FROM entries WHERE lower(path) LIKE '%manifest.json' \
         OR lower(path) LIKE '%complete' ORDER BY path",
    )?;
    let mut selected: Option<(String, String, String)> = None;
    let mut controls = false;
    let mut count = 0;
    stage
        .db
        .execute_batch("CREATE TABLE snapshot_stamps(stamp TEXT PRIMARY KEY);")?;
    for row in rows {
        let path = row?;
        let base = path.rsplit('/').next().unwrap_or_default();
        if base.eq_ignore_ascii_case("COMPLETE") {
            controls = true;
            if base != "COMPLETE" {
                return Err(invalid());
            }
            continue;
        }
        if !base.eq_ignore_ascii_case("manifest.json") {
            continue;
        }
        if base != "manifest.json" {
            return Err(invalid());
        }
        controls = true;
        let prefix = path.strip_suffix("manifest.json").ok_or_else(invalid)?;
        let complete_path = format!("{prefix}COMPLETE");
        let exists: bool = stage.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM entries WHERE path=?1)",
            [&complete_path],
            |r| r.get(0),
        )?;
        if !exists {
            continue;
        }
        let (file, _, hash) = stage.entry(&path)?;
        let complete = read_text(stage.entry(&complete_path)?.0, 256)?;
        let mut de = serde_json::Deserializer::from_reader(BufReader::new(file));
        // Stream records into the disk plan while validating each candidate; retain only the selected candidate afterward.
        stage
            .db
            .execute_batch("DELETE FROM notes; DELETE FROM attachments;")?;
        let parsed = ManifestSeed { stage, cancel }.deserialize(&mut de);
        cancel.check()?;
        let (version, stamp) = parsed.map_err(|_| invalid())?;
        de.end().map_err(|_| invalid())?;
        let marker = format!("{BACKUP_FORMAT} v{version}\nmanifest-sha256 {hash}\n");
        let normalized = complete.replace("\r\n", "\n");
        if normalized != marker && normalized != marker.trim_end_matches('\n') {
            return Err(invalid());
        }
        let root = if version == 2 {
            let suffix = format!("snapshots/{stamp}/");
            prefix.strip_suffix(&suffix).ok_or_else(invalid)?.to_owned()
        } else {
            prefix.to_owned()
        };
        if !root.is_empty() {
            safe_path(root.trim_end_matches('/'))?;
        }
        if selected
            .as_ref()
            .is_some_and(|(_, old_root, _)| old_root != &root)
        {
            return Err(Error::invalid("source", "ambiguous backup roots"));
        }
        stage
            .db
            .execute("INSERT INTO snapshot_stamps VALUES(?1)", [&stamp])
            .map_err(|_| Error::invalid("source", "ambiguous complete snapshots"))?;
        count += 1;
        match &selected {
            Some((old, _, _)) if old == &stamp => {
                return Err(Error::invalid("source", "ambiguous complete snapshots"));
            }
            Some((old, _, _)) if old > &stamp => (),
            _ => selected = Some((stamp, root, path)),
        }
    }
    if let Some((_, root, path)) = selected {
        stage
            .db
            .execute_batch("DELETE FROM notes; DELETE FROM attachments;")?;
        let (file, _, _) = stage.entry(&path)?;
        let mut de = serde_json::Deserializer::from_reader(BufReader::new(file));
        let parsed = ManifestSeed { stage, cancel }.deserialize(&mut de);
        cancel.check()?;
        let (version, stamp) = parsed.map_err(|_| invalid())?;
        de.end().map_err(|_| invalid())?;
        stage
            .db
            .execute_batch("CREATE TABLE declared_paths(path TEXT PRIMARY KEY COLLATE NOCASE);")?;
        let mut notes = stage.db.prepare("SELECT data FROM notes ORDER BY id")?;
        for raw in notes.query_map([], |r| r.get::<_, String>(0))? {
            cancel.check()?;
            let note: NoteEntry = serde_json::from_str(&raw?).map_err(|_| invalid())?;
            let expected = if version == 2 {
                format!("snapshots/{stamp}/{}/", note.state)
            } else {
                format!("{}/", note.state)
            };
            if !note.path.starts_with(&expected) {
                return Err(invalid());
            }
            stage
                .db
                .execute("INSERT INTO declared_paths VALUES(?1)", [&note.path])
                .map_err(|_| invalid())?;
            let (_, size, hash) = stage.entry(&format!("{root}{}", note.path))?;
            if size != note.bytes || hash != note.sha256 {
                return Err(invalid());
            }
            for hash in &note.attachment_hashes {
                let found: Option<String> = stage
                    .db
                    .query_row("SELECT hash FROM attachments WHERE hash=?1", [hash], |r| {
                        r.get(0)
                    })
                    .optional()?;
                if found.is_none() {
                    return Err(invalid());
                }
            }
        }
        let mut attachments = stage
            .db
            .prepare("SELECT data FROM attachments ORDER BY hash")?;
        for raw in attachments.query_map([], |r| r.get::<_, String>(0))? {
            cancel.check()?;
            let entry: AttachmentEntry = serde_json::from_str(&raw?).map_err(|_| invalid())?;
            stage
                .db
                .execute("INSERT INTO declared_paths VALUES(?1)", [&entry.path])
                .map_err(|_| invalid())?;
            let (_, size, hash) = stage.entry(&format!("{root}{}", entry.path))?;
            if size != entry.size || hash != entry.sha256 {
                return Err(invalid());
            }
            validate_attachment_file(stage.entry(&format!("{root}{}", entry.path))?.0, &entry)?;
        }
        if count > 1 {
            stage.db.execute("INSERT INTO warnings VALUES('Multiple complete snapshots: restored the latest complete snapshot')",[])?;
        }
        return Ok(Some((root, path)));
    }
    if controls {
        return Err(invalid());
    }
    Ok(None)
}

