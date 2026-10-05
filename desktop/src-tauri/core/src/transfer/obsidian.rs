use super::format::{self, AttachmentEntry, PlanNote};
use super::stage::Stage;
use super::{CancellationToken, ProgressSink, TransferService};
use crate::{Error, ProgressPhase};
use rusqlite::{OptionalExtension, params};

pub(super) fn plan(
    stage: &Stage,
    service: &TransferService,
    progress: &dyn ProgressSink,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    stage.db.execute_batch("CREATE TABLE vault(path TEXT PRIMARY KEY COLLATE NOCASE,name TEXT NOT NULL COLLATE NOCASE,id TEXT NOT NULL,title TEXT NOT NULL,asset INTEGER NOT NULL); CREATE INDEX vault_name ON vault(name);")?;
    stage.db.execute_batch("CREATE TABLE aliases(name TEXT NOT NULL COLLATE NOCASE,path TEXT NOT NULL); CREATE INDEX alias_name ON aliases(name);")?;
    let now = service.library.clock.now()?.get();
    let mut entries = stage
        .db
        .prepare("SELECT path FROM input_paths WHERE path NOT LIKE '.obsidian/%' ORDER BY path")?;
    for raw in entries.query_map([], |r| r.get::<_, String>(0))? {
        cancel.check()?;
        let path = raw?;
        let name = path.rsplit('/').next().unwrap_or_default();
        let extension = name.rsplit('.').next().unwrap_or_default().to_lowercase();
        let asset = matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "pdf"
        );
        if !asset && !matches!(extension.as_str(), "md" | "markdown" | "txt") {
            continue;
        }
        let random: Vec<u8> = stage
            .db
            .query_row("SELECT randomblob(16)", [], |r| r.get(0))?;
        let bytes: [u8; 16] = random.try_into().map_err(|_| format::invalid())?;
        let id = crate::id::encode_id(now as u64, &bytes);
        let mut title = name.rsplit_once('.').map_or(name, |v| v.0).to_owned();
        if !asset {
            let content = format::read_text(stage.entry(&path)?.0, format::CONTENT_MAX as u64)?;
            let mut created = now;
            let mut updated = now;
            frontmatter(&content, &mut title, &mut created, &mut updated, stage)?;
            if let Some((body, _)) = content
                .strip_prefix("---\n")
                .and_then(|v| v.split_once("\n---"))
            {
                for line in body.lines() {
                    if let Some((key, values)) = line.split_once(':')
                        && matches!(key.trim(), "alias" | "aliases")
                    {
                        for alias in values.trim().trim_matches(['[', ']']).split(',') {
                            let alias = alias.trim().trim_matches(['\'', '"']);
                            if !alias.is_empty() {
                                stage.db.execute(
                                    "INSERT INTO aliases VALUES(?1,?2)",
                                    params![alias, path],
                                )?;
                            }
                        }
                    }
                }
            }
        }
        stage.db.execute(
            "INSERT INTO vault VALUES(?1,?2,?3,?4,?5)",
            params![path, name, id, title, asset],
        )?;
        if asset {
            let (mut file, size, hash) = stage.entry(&path)?;
            if size > format::ATTACHMENT_MAX {
                return Err(Error::TooLarge {
                    field: "source",
                    limit: format::ATTACHMENT_MAX,
                });
            }
            let mime = asset_mime(&extension, &mut file)?;
            let entry = AttachmentEntry {
                path: format!("attachments/{hash}--{}", super::export::safe_segment(name)),
                filename: name.to_owned(),
                mime: mime.to_owned(),
                size,
                sha256: hash.clone(),
                created_at: now,
            };
            entry.validate()?;
            // Alias the disk object without copying or putting binary bytes in the plan.
            stage.db.execute("INSERT OR IGNORE INTO entries SELECT ?1,object,size,hash FROM entries WHERE path=?2",params![entry.path,path])?;
            stage.db.execute(
                "INSERT OR IGNORE INTO attachments VALUES(?1,?2)",
                params![
                    hash,
                    serde_json::to_string(&entry).map_err(|_| format::invalid())?
                ],
            )?;
        }
    }
    drop(entries);
    let mut notes = stage
        .db
        .prepare("SELECT path,id,title FROM vault WHERE asset=0 ORDER BY path")?;
    let mut count = 0;
    for raw in notes.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        cancel.check()?;
        let (path, id, mut title) = raw?;
        let mut content = format::read_text(stage.entry(&path)?.0, format::CONTENT_MAX as u64)?;
        let mut created = now;
        let mut updated = now;
        frontmatter(&content, &mut title, &mut created, &mut updated, stage)?;
        content = rewrite(&content, |reference, asset| {
            resolve(stage, &path, reference, asset)
        })?;
        let folder = path
            .rsplit_once('/')
            .map_or(Vec::new(), |v| v.0.split('/').map(str::to_owned).collect());
        let note = PlanNote {
            id: id.clone(),
            title,
            content,
            folder,
            created_at: created,
            updated_at: updated,
            deleted_at: None,
            is_archived: false,
            is_starred: false,
            is_pinned: false,
        };
        format::validate_plan(&note)?;
        stage.db.execute(
            "INSERT INTO notes VALUES(?1,?2)",
            params![
                id,
                serde_json::to_string(&note).map_err(|_| format::invalid())?
            ],
        )?;
        count += 1;
        service.progress(progress, ProgressPhase::Validating, count);
    }
    Ok(())
}
fn asset_mime(extension: &str, file: &mut std::fs::File) -> Result<&'static str, Error> {
    use std::io::Read;
    let mut prefix = [0u8; 128];
    let n = file.read(&mut prefix)?;
    let bytes = &prefix[..n];
    match extension {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && n >= 24 => Ok("image/png"),
        "jpg" | "jpeg" if bytes.starts_with(&[255, 216, 255]) => Ok("image/jpeg"),
        "gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Ok("image/gif"),
        "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            Ok("image/webp")
        }
        "avif"
            if bytes.get(4..8) == Some(b"ftyp")
                && bytes.windows(4).any(|v| v == b"avif" || v == b"avis") =>
        {
            Ok("image/avif")
        }
        "pdf" if bytes.starts_with(b"%PDF-") => Ok("application/pdf"),
        // SVG is attachment-only in the host protocol, never executable inline content.
        "svg"
            if std::str::from_utf8(bytes).is_ok_and(|text| {
                text.trim_start().starts_with("<svg") || text.trim_start().starts_with("<?xml")
            }) =>
        {
            Ok("image/svg+xml")
        }
        _ => Err(Error::invalid(
            "source",
            "attachment content does not match its type",
        )),
    }
}
fn frontmatter(
    content: &str,
    title: &mut String,
    created: &mut i64,
    updated: &mut i64,
    stage: &Stage,
) -> Result<(), Error> {
    let Some(body) = content
        .strip_prefix("---\n")
        .and_then(|v| v.split_once("\n---"))
    else {
        return Ok(());
    };
    for line in body.0.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(['\'', '"']);
        match key.trim() {
            "title" => *title = value.to_owned(),
            "created" | "createdAt" | "updated" | "updatedAt" => {
                let millis = value.parse::<i64>().ok().or_else(|| {
                    time::OffsetDateTime::parse(
                        value,
                        &time::format_description::well_known::Rfc3339,
                    )
                    .ok()
                    .and_then(|at| i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok())
                });
                if let Some(at) = millis {
                    format::timestamp(at)?;
                    if key.trim().starts_with("created") {
                        *created = at
                    } else {
                        *updated = at
                    }
                } else {
                    stage.db.execute("INSERT INTO warnings VALUES('Unsupported Obsidian time field preserved verbatim')",[])?;
                }
            }
            "tags" | "aliases" | "alias" => (),
            _ => {
                stage.db.execute(
                    "INSERT INTO warnings VALUES('Unsupported frontmatter preserved verbatim')",
                    [],
                )?;
            }
        }
    }
    Ok(())
}
fn normalize(reference: &str, from: &str) -> Option<String> {
    let clean = reference.trim();
    if clean.starts_with('/') || clean.contains(':') || clean.contains('\\') {
        return None;
    }
    let mut parts: Vec<&str> = from.split('/').filter(|p| !p.is_empty()).collect();
    for part in clean.split('/') {
        match part {
            "." | "" => (),
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}
fn resolve(
    stage: &Stage,
    from: &str,
    reference: &str,
    asset: bool,
) -> Result<Option<String>, Error> {
    let decoded = decode_reference(reference);
    let reference = decoded.as_deref().unwrap_or(reference);
    let (base, fragment) = reference
        .split_once('#')
        .map_or((reference, ""), |(a, b)| (a, b));
    if base.starts_with(['#', '^']) || base.contains(':') {
        return Ok(None);
    }
    let dir = from.rsplit_once('/').map_or("", |v| v.0);
    let mut found = None;
    for candidate in [normalize(base, dir), normalize(base, "")]
        .into_iter()
        .flatten()
    {
        for candidate in [candidate.clone(), format!("{candidate}.md")] {
            let entry: Option<(String, String)> = stage
                .db
                .query_row(
                    "SELECT path,title FROM vault WHERE path=?1 AND asset=?2",
                    params![candidate, asset],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if entry.is_some() {
                found = entry;
                break;
            }
        }
        if found.is_some() {
            break;
        }
    }
    if found.is_none() {
        let name = base.rsplit('/').next().unwrap_or(base);
        let mut stmt=stage.db.prepare("SELECT DISTINCT path,title FROM vault WHERE (name=?1 OR name=?2 OR title=?1 OR path IN (SELECT path FROM aliases WHERE name=?1)) AND asset=?3 LIMIT 2")?;
        let mut rows = stmt.query(params![name, format!("{name}.md"), asset])?;
        if let Some(row) = rows.next()? {
            let candidate = (row.get(0)?, row.get(1)?);
            if rows.next()?.is_none() {
                found = Some(candidate)
            } else {
                stage.db.execute(
                    "INSERT INTO warnings VALUES('Ambiguous vault link preserved unchanged')",
                    [],
                )?;
            }
        }
    }
    let Some((path, _title)) = found else {
        return Ok(None);
    };
    if asset {
        let hash: String =
            stage
                .db
                .query_row("SELECT hash FROM entries WHERE path=?1", [path], |r| {
                    r.get(0)
                })?;
        Ok(Some(format!(
            "autonote-import-hash:{hash}{}",
            if fragment.is_empty() {
                String::new()
            } else {
                format!("#{fragment}")
            }
        )))
    } else {
        let id: String = stage
            .db
            .query_row("SELECT id FROM vault WHERE path=?1", [path], |r| r.get(0))?;
        Ok(Some(format!(
            "/notes/{id}{}",
            if fragment.is_empty() {
                String::new()
            } else {
                format!("#{fragment}")
            }
        )))
    }
}
fn decode_reference(value: &str) -> Option<String> {
    if !value.contains('%') {
        return None;
    }
    let mut bytes = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        if value.as_bytes()[index] == b'%' {
            let pair = value.get(index + 1..index + 3)?;
            let byte = u8::from_str_radix(pair, 16).ok()?;
            // Decode filenames once, never separators, control bytes or dot traversal.
            if matches!(byte, b'/' | b'\\' | b':' | b'.' | b'#') || byte.is_ascii_control() {
                return None;
            }
            bytes.push(byte);
            index += 3;
        } else {
            bytes.push(value.as_bytes()[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).ok()
}
/// A single scanner keeps code regions byte-for-byte intact, unlike global regex replacement.
pub(super) fn rewrite(
    content: &str,
    resolve: impl FnMut(&str, bool) -> Result<Option<String>, Error>,
) -> Result<String, Error> {
    rewrite_links(content, resolve, true)
}
pub(super) fn rewrite_links(
    content: &str,
    mut resolve: impl FnMut(&str, bool) -> Result<Option<String>, Error>,
    comments: bool,
) -> Result<String, Error> {
    let mut out = String::with_capacity(content.len());
    let mut fenced: Option<(u8, usize)> = None;
    let mut inline = None;
    let mut comment = false;
    for line in content.split_inclusive('\n') {
        if inline.is_none() && !comment && (line.starts_with("    ") || line.starts_with('\t')) {
            out.push_str(line);
            continue;
        }
        let trimmed = line.trim_start();
        let marker = trimmed.as_bytes().first().copied();
        let run = marker.map_or(0, |m| trimmed.bytes().take_while(|b| *b == m).count());
        if inline.is_none() && !comment && matches!(marker, Some(b'`' | b'~')) && run >= 3 {
            if fenced.is_none() {
                fenced = Some((marker.unwrap_or_default(), run))
            } else if fenced.is_some_and(|(m, n)| Some(m) == marker && run >= n) {
                fenced = None
            }
            out.push_str(line);
            continue;
        }
        if fenced.is_some() {
            out.push_str(line);
            continue;
        }
        let mut index = 0;
        while index < line.len() {
            let tail = &line[index..];
            if comment {
                if let Some(end) = tail.find("%%") {
                    out.push_str(&tail[..end].replace("--", "—"));
                    out.push_str("-->");
                    index += end + 2;
                    comment = false;
                } else {
                    out.push_str(&tail.replace("--", "—"));
                    break;
                }
                continue;
            }
            if let Some(length) = inline {
                let token = "`".repeat(length);
                if let Some(end) = tail.find(&token) {
                    out.push_str(&tail[..end + length]);
                    index += end + length;
                    inline = None;
                } else {
                    out.push_str(tail);
                    break;
                }
                continue;
            }
            if tail.starts_with('\\') {
                let mut chars = tail.chars();
                let _slash = chars.next();
                let length = 1 + chars.next().map_or(0, char::len_utf8);
                out.push_str(&tail[..length]);
                index += length;
                continue;
            }
            if tail.starts_with('`') {
                let n = tail.bytes().take_while(|b| *b == b'`').count();
                let token = "`".repeat(n);
                if let Some(end) = tail[n..].find(&token) {
                    let length = n + end + n;
                    out.push_str(&tail[..length]);
                    index += length;
                    continue;
                }
                out.push_str(&tail[..n]);
                index += n;
                inline = Some(n);
                continue;
            }
            let asset = tail.starts_with("![[");
            let wiki = tail.starts_with("[[") || asset;
            if wiki {
                let start = if asset { 3 } else { 2 };
                if let Some(end) = tail[start..].find("]]") {
                    let inside = &tail[start..start + end];
                    let (target, alias) = inside
                        .split_once('|')
                        .map_or((inside, None), |(a, b)| (a, Some(b)));
                    let length = start + end + 2;
                    if let Some(url) = resolve(target, asset)? {
                        if url.starts_with("/notes/") || asset {
                            out.push_str(&format!(
                                "{}[{}]({url})",
                                if asset { "!" } else { "" },
                                alias.unwrap_or(target)
                            ));
                        } else {
                            out.push_str(&format!(
                                "[[{url}{}]]",
                                alias.map_or(String::new(), |a| format!("|{a}"))
                            ));
                        }
                    } else {
                        out.push_str(&tail[..length])
                    }
                    index += length;
                    continue;
                }
            }
            if tail.starts_with("![") || tail.starts_with('[') {
                let asset = tail.starts_with("![");
                let start = if asset { 2 } else { 1 };
                if let Some(end) = tail[start..].find("](") {
                    let href_start = start + end + 2;
                    if let Some(close) = tail[href_start..].find(')') {
                        let href = &tail[href_start..href_start + close];
                        let length = href_start + close + 1;
                        if let Some(url) = resolve(href, asset)? {
                            out.push_str(&format!(
                                "{}[{}]({url})",
                                if asset { "!" } else { "" },
                                &tail[start..start + end]
                            ))
                        } else {
                            out.push_str(&tail[..length])
                        }
                        index += length;
                        continue;
                    }
                }
            }
            if comments && tail.starts_with("%%") {
                out.push_str("<!--");
                index += 2;
                comment = true;
                continue;
            }
            let ch = tail.chars().next().ok_or_else(format::invalid)?;
            out.push(ch);
            index += ch.len_utf8();
        }
    }
    if comment {
        out.push_str("-->");
    }
    Ok(out)
}
