//! Attachment IDs change only in transport copies, never in local source notes.
use crate::remote::{ATTACHMENT_MAX_BYTES, CallOptions, RemoteClient, RemoteError};
use crate::service::blocking;
use note_core::sync::{AttachmentMap, AttachmentState, Binding, SyncEntity};
use note_core::{AppError, Attachment, AttachmentId, ErrorCode, Library, Note};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::Arc;

#[derive(Debug)]
pub enum AttachmentError {
    Core(AppError),
    Remote(RemoteError),
    UnknownOutcome { local_id: String },
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
            Self::UnknownOutcome { .. } => ErrorCode::Conflict,
            Self::InvalidResponse => ErrorCode::InvalidResponse,
        }
    }
    /// Converts the attachment failure to an application error.
    pub fn app_error(&self) -> AppError {
        AppError::new(self.code(), "Attachment synchronization paused or failed")
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadIntent {
    local_id: String,
    sha256: String,
    size: u64,
    filename: String,
    note_id: Option<String>,
    known_remote_ids: HashSet<String>,
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

async fn maps(
    library: &Arc<Library>,
    binding: &Binding,
) -> Result<Vec<AttachmentMap>, AttachmentError> {
    let binding = binding.clone();
    Ok(blocking(library, move |lib| lib.sync_attachment_maps(&binding)).await?)
}
async fn persist(
    library: &Arc<Library>,
    binding: &Binding,
    map: &AttachmentMap,
) -> Result<(), AttachmentError> {
    let binding = binding.clone();
    let map = map.clone();
    Ok(blocking(library, move |lib| {
        lib.sync_put_attachment_map(&binding, &map)
    })
    .await?)
}
async fn source(
    library: &Arc<Library>,
    id: &str,
) -> Result<(Vec<u8>, Attachment, String), AttachmentError> {
    let id: AttachmentId = id.parse()?;
    Ok(blocking(library, move |lib| lib.files_sync_source(&id)).await?)
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

/// Read-only preview count; neither metadata nor attachment bytes are adopted.
/// Counts remote attachments without adopting metadata or bytes.
///
/// # Errors
/// Returns a remote, cancellation, timeout, or invalid-response error.
pub async fn remote_attachment_count(
    remote: &RemoteClient,
    options: &CallOptions,
) -> Result<u64, RemoteError> {
    remote_files(remote, options)
        .await
        .map(|files| files.len() as u64)
        .map_err(|error| match error {
            AttachmentError::Remote(error) => error,
            _ => RemoteError::new(ErrorCode::InvalidResponse),
        })
}

/// Frozen full-note outbox payload and its local-ID acknowledgement prerequisites.
/// Prepares a frozen note payload for outbound synchronization.
///
/// # Errors
/// Returns an attachment, local storage, remote, cancellation, timeout, or invalid-response error.
pub async fn prepare_outbound(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    payload: &serde_json::Value,
    options: &CallOptions,
) -> Result<(serde_json::Value, Vec<String>), AttachmentError> {
    let note: Note =
        serde_json::from_value(payload.clone()).map_err(|_| AttachmentError::InvalidResponse)?;
    let mut ids: Vec<String> = references(&note.content)?
        .into_iter()
        .map(|range| note.content[range].to_owned())
        .collect();
    ids.sort();
    ids.dedup();
    let transport = prepare_note(library, remote, binding, &note, options).await?;
    Ok((
        serde_json::to_value(transport).map_err(|_| AttachmentError::InvalidResponse)?,
        ids,
    ))
}

fn candidate(intent: &UploadIntent, file: &Attachment) -> bool {
    !intent.known_remote_ids.contains(file.id.as_str())
        && file.filename == intent.filename
        && file.size == intent.size
        && file.note_id.as_ref().map(|id| id.as_str()) == intent.note_id.as_deref()
}
fn unique_match(matches: &[String]) -> Option<&str> {
    (matches.len() == 1).then(|| matches[0].as_str())
}

/// Unknown outcomes never issue another POST. Full pagination and each candidate's
/// actual downloaded bytes are necessary because the Worker list has no checksum.
async fn reconcile(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    map: &mut AttachmentMap,
    options: &CallOptions,
) -> Result<String, AttachmentError> {
    let intent: UploadIntent = serde_json::from_value(
        map.upload_intent
            .clone()
            .ok_or(AttachmentError::InvalidResponse)?,
    )
    .map_err(|_| AttachmentError::InvalidResponse)?;
    if intent.local_id != map.local_attachment_id
        || intent.sha256 != map.sha256
        || i64::try_from(intent.size).ok() != Some(map.size)
    {
        return Err(AttachmentError::InvalidResponse);
    }
    map.state = AttachmentState::UnknownOutcome;
    persist(library, binding, map).await?;
    let mut matches = Vec::new();
    for file in remote_files(remote, options).await? {
        if !candidate(&intent, &file) {
            continue;
        }
        let bytes = remote.download_file(file.id.as_str(), options).await?;
        if bytes.len() as u64 == intent.size && digest(&bytes) == intent.sha256 {
            let id = file.id.to_string();
            if !matches.contains(&id) {
                matches.push(id);
            }
        }
    }
    let Some(id) = unique_match(&matches) else {
        return Err(AttachmentError::UnknownOutcome {
            local_id: map.local_attachment_id.clone(),
        });
    };
    map.remote_attachment_id = Some(id.to_owned());
    map.state = AttachmentState::Ready;
    persist(library, binding, map).await?;
    Ok(id.to_owned())
}

/// Produces the outgoing note DTO only after every real referenced attachment is confirmed.
/// Existing unknown upload outcomes pause; they are not silently retried.
/// Resolves every referenced attachment and rewrites a transport note.
///
/// # Errors
/// Returns an attachment, local storage, remote, cancellation, timeout, or invalid-response error.
pub async fn prepare_note(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    note: &Note,
    options: &CallOptions,
) -> Result<Note, AttachmentError> {
    let ranges = references(&note.content)?;
    let mut replacements = HashMap::new();
    let mut maps = maps(library, binding).await?;
    for range in &ranges {
        let local_id = &note.content[range.clone()];
        if replacements.contains_key(local_id) {
            continue;
        }
        check(options)?;
        if let Some(map) = maps
            .iter_mut()
            .find(|map| map.local_attachment_id == local_id)
        {
            match map.state {
                AttachmentState::Ready => {
                    replacements.insert(
                        local_id.to_owned(),
                        map.remote_attachment_id
                            .clone()
                            .ok_or(AttachmentError::InvalidResponse)?,
                    );
                    continue;
                }
                AttachmentState::Uploading | AttachmentState::UnknownOutcome => {
                    replacements.insert(
                        local_id.to_owned(),
                        reconcile(library, remote, binding, map, options).await?,
                    );
                    continue;
                }
                _ => {}
            }
        }
        let (bytes, metadata, sha256) = source(library, local_id).await?;
        let known_remote_ids = remote_files(remote, options)
            .await?
            .into_iter()
            .map(|file| file.id.to_string())
            .collect();
        // A new remote note does not exist yet; associate only a confirmed remote note ID.
        let key = binding.clone();
        let id = note.summary.id.to_string();
        let note_id = blocking(library, move |lib| {
            lib.sync_map_for_local(&key, SyncEntity::Note, &id)
        })
        .await?
        .map(|mapping| mapping.remote_id);
        let intent = UploadIntent {
            local_id: local_id.to_owned(),
            sha256: sha256.clone(),
            size: metadata.size,
            filename: metadata.filename.clone(),
            note_id,
            known_remote_ids,
        };
        let mut map = AttachmentMap {
            binding_id: binding.binding_id.clone(),
            binding_epoch: binding.binding_epoch,
            local_attachment_id: local_id.to_owned(),
            remote_attachment_id: None,
            sha256,
            size: i64::try_from(metadata.size).map_err(|_| AttachmentError::InvalidResponse)?,
            upload_intent: Some(
                serde_json::to_value(&intent).map_err(|_| AttachmentError::InvalidResponse)?,
            ),
            state: AttachmentState::Uploading,
        };
        check(options)?;
        // Durable before POST, including the baseline remote ID set. A crash after
        // this commit is conservatively unknown even if the POST never left the host.
        persist(library, binding, &map).await?;
        let result = remote
            .upload_file(
                &metadata.filename,
                &metadata.mime,
                bytes,
                intent.note_id.as_deref(),
                options,
            )
            .await;
        match result {
            Ok(file)
                if file.filename == intent.filename
                    && file.size == intent.size
                    && file.note_id.as_ref().map(|id| id.as_str()) == intent.note_id.as_deref()
                    && !intent.known_remote_ids.contains(file.id.as_str()) =>
            {
                map.remote_attachment_id = Some(file.id.to_string());
                map.state = AttachmentState::Ready;
                persist(library, binding, &map).await?;
                replacements.insert(local_id.to_owned(), file.id.to_string());
                maps.push(map);
            }
            result => {
                map.state = AttachmentState::UnknownOutcome;
                persist(library, binding, &map).await?;
                return match result {
                    Err(error) => Err(error.into()),
                    Ok(_) => Err(AttachmentError::InvalidResponse),
                };
            }
        }
    }
    let mut transport = note.clone();
    transport.content = rewrite(&note.content, &ranges, &replacements)?;
    Ok(transport)
}

/// Downloads to the core's restricted stage and publishes only verified objects.
/// The returned local-reference note belongs in the caller's pull transaction.
/// No server-supplied hash exists: the stored digest is local integrity evidence only.
/// Materializes every referenced remote attachment into local storage.
///
/// # Errors
/// Returns an attachment, local storage, remote, cancellation, timeout, or invalid-response error.
pub async fn materialize_note(
    library: &Arc<Library>,
    remote: &RemoteClient,
    binding: &Binding,
    note: &Note,
    options: &CallOptions,
) -> Result<Note, AttachmentError> {
    let ranges = references(&note.content)?;
    let mut replacements = HashMap::new();
    let maps = maps(library, binding).await?;
    let mut listing = None;
    for range in &ranges {
        let remote_id = &note.content[range.clone()];
        if replacements.contains_key(remote_id) {
            continue;
        }
        check(options)?;
        if let Some(map) = maps.iter().find(|map| {
            map.remote_attachment_id.as_deref() == Some(remote_id)
                && matches!(map.state, AttachmentState::Ready)
        }) {
            let (bytes, _, hash) = source(library, &map.local_attachment_id).await?;
            if i64::try_from(bytes.len()).ok() != Some(map.size) || hash != map.sha256 {
                return Err(AttachmentError::InvalidResponse);
            }
            replacements.insert(remote_id.to_owned(), map.local_attachment_id.clone());
            continue;
        }
        if listing.is_none() {
            listing = Some(remote_files(remote, options).await?);
        }
        let metadata = listing
            .as_ref()
            .and_then(|files| files.iter().find(|file| file.id.as_str() == remote_id))
            .ok_or(AttachmentError::InvalidResponse)?;
        if metadata.size > ATTACHMENT_MAX_BYTES as u64 {
            return Err(RemoteError::new(ErrorCode::PayloadTooLarge).into());
        }
        let bytes = remote.download_file(remote_id, options).await?;
        if bytes.len() as u64 != metadata.size {
            return Err(AttachmentError::InvalidResponse);
        }
        let hash = digest(&bytes);
        let window = format!("sync:{}:{}", binding.binding_id, binding.binding_epoch);
        let metadata = metadata.clone();
        let key = binding.clone();
        let id = remote_id.to_owned();
        let options = options.clone();
        let local = blocking(library, move |lib| {
            let begin = lib.files_upload_begin(
                &window,
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
                    if std::time::Instant::now() >= options.deadline {
                        return Err(note_core::Error::invalid(
                            "deadline",
                            "attachment staging deadline expired",
                        ));
                    }
                    offset = lib.files_upload_chunk(&window, &begin.upload_id, offset, chunk)?;
                }
                if options.cancel.is_cancelled() {
                    return Err(note_core::Error::Cancelled);
                }
                lib.files_sync_finish(&window, &begin.upload_id, &key, &id, &hash)
            })();
            if staged.is_err() {
                lib.files_upload_cancel(&window, &begin.upload_id)?;
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

/// Startup repair never removes referenced official files or retries uncertain POSTs.
/// Repairs staged files and marks interrupted uploads as uncertain.
///
/// # Errors
/// Returns a local storage error when repair or persistence fails.
pub async fn recover(library: &Arc<Library>, binding: &Binding) -> Result<(), AttachmentError> {
    let binding = binding.clone();
    Ok(blocking(library, move |lib| {
        lib.files_recover()?;
        for mut map in lib.sync_attachment_maps(&binding)? {
            if matches!(map.state, AttachmentState::Uploading) {
                map.state = AttachmentState::UnknownOutcome;
                lib.sync_put_attachment_map(&binding, &map)?;
            }
        }
        Ok(())
    })
    .await?)
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
        let intent = UploadIntent {
            local_id: local.to_owned(),
            sha256: digest(b"real bytes"),
            size: 10,
            filename: "image.png".to_owned(),
            note_id: None,
            known_remote_ids: HashSet::from([local.to_owned()]),
        };
        let round_trip: UploadIntent = serde_json::to_value(&intent)
            .and_then(serde_json::from_value)
            .map_err(|_| AttachmentError::InvalidResponse)?;
        assert!(round_trip.known_remote_ids.contains(local));
        assert_eq!(round_trip.sha256, digest(b"real bytes"));
        Ok(())
    }
}
