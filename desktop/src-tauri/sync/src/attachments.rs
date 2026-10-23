//! Attachment ids change only in request copies, never in local notes (22 §7.5).
use crate::remote::{ATTACHMENT_MAX_BYTES, CallOptions, RemoteClient, RemoteError};
use crate::service::blocking;
use note_core::{AppError, Attachment, AttachmentId, ErrorCode, Library, Note};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::Arc;

#[derive(Debug)]
pub enum AttachmentError {
    Core(AppError),
    Remote(RemoteError),
    InvalidResponse,
}
impl From<note_core::Error> for AttachmentError {
    fn from(error: note_core::Error) -> Self {
        Self::Core(error.into())
    }
}
impl From<AppError> for AttachmentError {
    fn from(error: AppError) -> Self {
        Self::Core(error)
    }
}
impl From<RemoteError> for AttachmentError {
    fn from(error: RemoteError) -> Self {
        Self::Remote(error)
    }
}
impl AttachmentError {
    /// Returns the normalized synchronization error code.
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Core(error) => error.code(),
            Self::Remote(error) => error.code,
            Self::InvalidResponse => ErrorCode::InvalidResponse,
        }
    }
    /// Converts the attachment failure to an application error.
    pub fn app_error(&self) -> AppError {
        AppError::new(self.code(), "Attachment synchronization failed")
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn check(options: &CallOptions) -> Result<(), AttachmentError> {
    if options.cancel.is_cancelled() {
        return Err(RemoteError::new(ErrorCode::Cancelled).into());
    }
    if std::time::Instant::now() >= options.deadline {
        return Err(RemoteError::new(ErrorCode::RequestTimeout).into());
    }
    Ok(())
}
async fn source(
    library: &Arc<Library>,
    id: &str,
) -> Result<Option<(Vec<u8>, Attachment, String)>, AttachmentError> {
    let id: AttachmentId = id.parse()?;
    match blocking(library, move |lib| lib.files_sync_source(&id)).await {
        Ok(found) => Ok(Some(found)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Scans every page. A repeated continuation is an invalid response, not a partial success.
async fn remote_files(
    remote: &RemoteClient,
    options: &CallOptions,
) -> Result<Vec<Attachment>, AttachmentError> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = None;
    loop {
        let page = remote.list_attachments(cursor.as_deref(), options).await?;
        files.extend(page.files.into_iter().map(|file| file.attachment));
        let Some(next) = page.next_cursor else {
            return Ok(files);
        };
        if next.is_empty() || !seen.insert(next.clone()) {
            return Err(AttachmentError::InvalidResponse);
        }
        cursor = Some(next);
    }
}

/// Whether a remote file could be an earlier upload of this local one.
fn candidate(local: &Attachment, file: &Attachment) -> bool {
    file.filename == local.filename && file.size == local.size
}
fn unique_match(matches: &[String]) -> Option<&str> {
    (matches.len() == 1).then(|| matches[0].as_str())
}

/// Uploads unmapped local attachments and returns the request copy of `note`
/// with remote ids. A lost upload response is recovered by matching remote
/// candidates by name, size and digest; at worst one orphan remains remotely.
///
/// # Errors
/// Returns a local storage, remote, cancellation, timeout or invalid-response error.
pub async fn prepare_note(
    library: &Arc<Library>,
    remote: &RemoteClient,
    note: &Note,
    options: &CallOptions,
) -> Result<Note, AttachmentError> {
    let ranges = references(&note.content)?;
    let mut replacements = HashMap::new();
    let mut listing: Option<Vec<Attachment>> = None;
    for range in &ranges {
        let local_id = &note.content[range.clone()];
        if replacements.contains_key(local_id) {
            continue;
        }
        check(options)?;
        let id = local_id.to_owned();
        if let Some(remote_id) =
            blocking(library, move |lib| lib.sync_attachment_remote(&id)).await?
        {
            replacements.insert(local_id.to_owned(), remote_id);
            continue;
        }
        // A reference to a file this library does not have is sent unchanged.
        let Some((bytes, metadata, sha256)) = source(library, local_id).await? else {
            replacements.insert(local_id.to_owned(), local_id.to_owned());
            continue;
        };
        if listing.is_none() {
            listing = Some(remote_files(remote, options).await?);
        }
        let mut matches = Vec::new();
        for file in listing
            .iter()
            .flatten()
            .filter(|file| candidate(&metadata, file))
        {
            let mapped_local = file.id.to_string();
            if blocking(library, move |lib| lib.sync_attachment_local(&mapped_local))
                .await?
                .is_some()
            {
                continue;
            }
            let downloaded = remote.download_file(file.id.as_str(), options).await?;
            if downloaded.len() as u64 == metadata.size && digest(&downloaded) == sha256 {
                matches.push(file.id.to_string());
            }
        }
        let remote_id = if let Some(found) = unique_match(&matches) {
            found.to_owned()
        } else {
            let uploaded = remote
                .upload_file(&metadata.filename, &metadata.mime, bytes, None, options)
                .await?;
            if uploaded.size != metadata.size {
                return Err(AttachmentError::InvalidResponse);
            }
            if let Some(files) = listing.as_mut() {
                files.push(uploaded.clone());
            }
            uploaded.id.to_string()
        };
        let (local, mapped_remote, hash, size) = (
            local_id.to_owned(),
            remote_id.clone(),
            sha256.clone(),
            metadata.size,
        );
        blocking(library, move |lib| {
            lib.sync_attachment_map(&local, &mapped_remote, &hash, size)
        })
        .await?;
        replacements.insert(local_id.to_owned(), remote_id);
    }
    let mut transport = note.clone();
    transport.content = rewrite(&note.content, &ranges, &replacements)?;
    Ok(transport)
}

/// Downloads remote attachments a note references and returns the local copy
/// of `note` with local ids. Bytes are size-checked and published with their
/// mapping in one core transaction. No server hash exists: the digest is local
/// integrity evidence only.
///
/// # Errors
/// Returns a local storage, remote, cancellation, timeout or invalid-response error.
pub async fn materialize_note(
    library: &Arc<Library>,
    remote: &RemoteClient,
    note: &Note,
    options: &CallOptions,
) -> Result<Note, AttachmentError> {
    let ranges = references(&note.content)?;
    let mut replacements = HashMap::new();
    let mut listing: Option<Vec<Attachment>> = None;
    for range in &ranges {
        let remote_id = &note.content[range.clone()];
        if replacements.contains_key(remote_id) {
            continue;
        }
        check(options)?;
        let id = remote_id.to_owned();
        if let Some(local) = blocking(library, move |lib| lib.sync_attachment_local(&id)).await? {
            replacements.insert(remote_id.to_owned(), local);
            continue;
        }
        if listing.is_none() {
            listing = Some(remote_files(remote, options).await?);
        }
        // A reference to a file the server no longer has stays as written.
        let Some(metadata) = listing
            .iter()
            .flatten()
            .find(|file| file.id.as_str() == remote_id)
            .cloned()
        else {
            replacements.insert(remote_id.to_owned(), remote_id.to_owned());
            continue;
        };
        if metadata.size > ATTACHMENT_MAX_BYTES as u64 {
            return Err(RemoteError::new(ErrorCode::PayloadTooLarge).into());
        }
        let bytes = remote.download_file(remote_id, options).await?;
        if bytes.len() as u64 != metadata.size {
            return Err(AttachmentError::InvalidResponse);
        }
        let hash = digest(&bytes);
        let (id, digest_copy, size) = (remote_id.to_owned(), hash.clone(), metadata.size);
        if let Some(local) = blocking(library, move |lib| {
            lib.sync_adopt_attachment(&id, &digest_copy, size)
        })
        .await?
        {
            replacements.insert(remote_id.to_owned(), local);
            continue;
        }
        let id = remote_id.to_owned();
        let options = options.clone();
        let local = blocking(library, move |lib| {
            let window = "sync";
            let begin = lib.files_upload_begin(
                window,
                &metadata.filename,
                &metadata.mime,
                metadata.size,
                None,
            )?;
            let staged = (|| {
                let mut offset = 0;
                for chunk in bytes.chunks(begin.chunk_max_bytes) {
                    if options.cancel.is_cancelled() {
                        return Err(note_core::Error::Cancelled);
                    }
                    offset = lib.files_upload_chunk(window, &begin.upload_id, offset, chunk)?;
                }
                lib.files_sync_finish(window, &begin.upload_id, &id, &hash)
            })();
            if staged.is_err() {
                lib.files_upload_cancel(window, &begin.upload_id)?;
            }
            staged
        })
        .await?;
        replacements.insert(remote_id.to_owned(), local.id.to_string());
    }
    let mut local = note.clone();
    local.content = rewrite(&note.content, &ranges, &replacements)?;
    Ok(local)
}

fn rewrite(
    source: &str,
    ranges: &[Range<usize>],
    replacements: &HashMap<String, String>,
) -> Result<String, AttachmentError> {
    let mut copy = String::with_capacity(source.len());
    let mut offset = 0;
    for range in ranges {
        copy.push_str(&source[offset..range.start]);
        copy.push_str(
            replacements
                .get(&source[range.clone()])
                .ok_or(AttachmentError::InvalidResponse)?,
        );
        offset = range.end;
    }
    copy.push_str(&source[offset..]);
    Ok(copy)
}

fn references(source: &str) -> Result<Vec<Range<usize>>, AttachmentError> {
    let mut ranges = note_core::markdown::attachment_references(source);
    ranges.extend(yaml_references(source)?);
    ranges.sort_by_key(|range| range.start);
    ranges.dedup();
    Ok(ranges)
}

// YAML is first parsed in full: malformed properties cannot be rewritten by a
// substring heuristic. Only complete URL-valued scalar tokens are file references.
fn yaml_references(source: &str) -> Result<Vec<Range<usize>>, AttachmentError> {
    let bom = usize::from(source.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
    let content = &source[bom..];
    let mut lines = content.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return Ok(Vec::new());
    };
    if first.trim_end_matches(['\r', '\n', ' ', '\t']) != "---" {
        return Ok(Vec::new());
    }
    let start = bom + first.len();
    let mut end = start;
    let mut closed = false;
    for line in lines {
        if matches!(
            line.trim_end_matches(['\r', '\n', ' ', '\t']),
            "---" | "..."
        ) {
            closed = true;
            break;
        }
        end += line.len();
        if end - start > 64 * 1024 {
            return Err(AttachmentError::InvalidResponse);
        }
    }
    if !closed {
        return Ok(Vec::new());
    }
    let yaml = &source[start..end];
    let value: serde_yaml::Value =
        serde_yaml::from_str(yaml).map_err(|_| AttachmentError::InvalidResponse)?;
    if !value.is_mapping() && !value.is_null() {
        return Err(AttachmentError::InvalidResponse);
    }
    let mut urls = HashSet::new();
    collect_yaml_urls(&value, &mut urls, 0)?;
    let mut ranges = Vec::new();
    let bytes = yaml.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            i += bytes[i..]
                .iter()
                .position(|&b| b == b'\n')
                .unwrap_or(bytes.len() - i);
            continue;
        }
        if matches!(bytes[i], b'"' | b'\'') {
            let quote = bytes[i];
            let token_start = i;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' && quote == b'"' {
                    i = (i + 2).min(bytes.len());
                    continue;
                }
                if bytes[i] == quote {
                    if quote == b'\'' && bytes.get(i + 1) == Some(&quote) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            let token = &yaml[token_start..i];
            if let Ok(serde_yaml::Value::String(url)) =
                serde_yaml::from_str::<serde_yaml::Value>(token)
                && urls.contains(&url)
                && token.get(1..token.len().saturating_sub(1)) == Some(url.as_str())
                && scalar_value_position(yaml, token_start)
                && !yaml[i..].trim_start().starts_with(':')
            {
                ranges.push(start + token_start + 12..start + token_start + 38);
            }
            continue;
        }
        if bytes[i..].starts_with(b"/api/files/") {
            let token_start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && !b",]}".contains(&bytes[i])
            {
                i += 1;
            }
            let token = &yaml[token_start..i];
            if urls.contains(token) && scalar_value_position(yaml, token_start) {
                ranges.push(start + token_start + 11..start + token_start + 37);
            }
            continue;
        }
        i += 1;
    }
    Ok(ranges)
}

fn scalar_value_position(yaml: &str, start: usize) -> bool {
    let prefix = yaml[..start].trim_end();
    prefix.ends_with([':', '-', '[', ','])
}
fn collect_yaml_urls(
    value: &serde_yaml::Value,
    urls: &mut HashSet<String>,
    depth: usize,
) -> Result<(), AttachmentError> {
    if depth > 20 {
        return Err(AttachmentError::InvalidResponse);
    }
    match value {
        serde_yaml::Value::String(url) => {
            if let Some(rest) = url.strip_prefix("/api/files/")
                && rest.get(..26).is_some_and(note_core::id::is_valid_id)
                && (rest.len() == 26 || rest.as_bytes().get(26).is_some_and(|b| b"?#".contains(b)))
            {
                urls.insert(url.clone());
            }
        }
        serde_yaml::Value::Sequence(values) => {
            for value in values {
                collect_yaml_urls(value, urls, depth + 1)?;
            }
        }
        serde_yaml::Value::Mapping(values) => {
            for value in values.values() {
                collect_yaml_urls(value, urls, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_reference_copy_and_uncertain_upload_check() -> Result<(), AttachmentError> {
        let local = "01arz3ndektsv4rrffq69g5fav";
        let remote = "01arz3ndektsv4rrffq69g5faz";
        let source = format!(
            "---\nfile: '/api/files/{local}'\nprose: 'literal {local}'\n---\n中文 ![image](/api/files/{local})\nplain /api/files/{local}\n`![code](/api/files/{local})`\n```\n![fenced](/api/files/{local})\n```\n<!-- ![hidden](/api/files/{local}) -->\n"
        );
        let original = source.clone();
        let ranges = references(&source)?;
        assert_eq!(ranges.len(), 2);
        let copy = rewrite(
            &source,
            &ranges,
            &HashMap::from([(local.to_owned(), remote.to_owned())]),
        )?;
        assert_eq!(source, original);
        assert!(copy.contains(&format!("file: '/api/files/{remote}'")));
        assert!(copy.contains(&format!("![image](/api/files/{remote})")));
        assert!(copy.contains(&format!("plain /api/files/{local}")));
        assert!(copy.contains(&format!("`![code](/api/files/{local})`")));
        assert!(unique_match(&[]).is_none());
        assert!(unique_match(&[local.to_owned(), remote.to_owned()]).is_none());
        assert_eq!(unique_match(&[remote.to_owned()]), Some(remote));
        Ok(())
    }
}
