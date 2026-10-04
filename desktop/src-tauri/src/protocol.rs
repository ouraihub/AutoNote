//! Strict ID-only custom URI protocol. Never resolves a caller-supplied disk path.
//!
//! Tauri protocol responses are one buffer (no streaming body), so reads run
//! on the blocking pool (`lib.rs` registers the asynchronous variant) and a
//! ranged response is capped at `MAX_SLICE`; `<video>`/`<audio>` then pull
//! the rest with follow-up ranges. Un-ranged GETs return the whole object,
//! bounded by the 25 MiB attachment limit, because `<img>` needs a 200.
use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

use note_core::{AttachmentId, Library};
use tauri::http::{Request, Response, StatusCode, header};

const MAX_SLICE: u64 = 4 * 1024 * 1024;

fn response(status: StatusCode, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[] as &[u8])))
}
fn range(value: &str, length: u64) -> Option<(u64, u64)> {
    let span = value.strip_prefix("bytes=")?;
    let (start, end) = span.split_once('-')?;
    if end.contains(',') || start.is_empty() && end.is_empty() || length == 0 {
        return None;
    }
    if start.is_empty() {
        let tail: u64 = end.parse().ok()?;
        if tail == 0 {
            return None;
        }
        return Some((length.saturating_sub(tail), length - 1));
    }
    let from: u64 = start.parse().ok()?;
    let to: u64 = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().ok()?.min(length - 1)
    };
    if from >= length || from > to {
        return None;
    }
    Some((from, to))
}

/// Serves only registered ID objects to the originating Tauri window.
pub fn serve(library: &Arc<Library>, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if request.method() != tauri::http::Method::GET && request.method() != tauri::http::Method::HEAD
    {
        return response(StatusCode::METHOD_NOT_ALLOWED, Vec::new());
    }
    // convertFileSrc(id, 'autonote-file') yields /id. Reject any other path,
    // percent escape, query, fragment or authority on every platform.
    let uri = request.uri();
    let path = uri.path();
    let Some(id) = path.strip_prefix('/') else {
        return response(StatusCode::NOT_FOUND, Vec::new());
    };
    if uri.query().is_some() || id.contains('/') || id.contains('%') {
        return response(StatusCode::NOT_FOUND, Vec::new());
    }
    let Ok(id) = id.parse::<AttachmentId>() else {
        return response(StatusCode::NOT_FOUND, Vec::new());
    };
    let Ok((mut file, metadata)) = library.files_open(&id) else {
        return response(StatusCode::NOT_FOUND, Vec::new());
    };
    let length = metadata.size;
    let requested = request.headers().get(header::RANGE);
    let selected = if let Some(raw) = requested {
        let parsed = raw.to_str().ok().and_then(|v| range(v, length));
        match parsed {
            Some(span) => Some(span),
            None => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                    .header("X-Content-Type-Options", "nosniff")
                    .body(Cow::Borrowed(&[] as &[u8]))
                    .unwrap_or_else(|_| response(StatusCode::NOT_FOUND, Vec::new()));
            }
        }
    } else {
        None
    };
    let (start, end) = selected.unwrap_or((0, length.saturating_sub(1)));
    let end = if selected.is_some() {
        end.min(start + MAX_SLICE - 1)
    } else {
        end
    };
    let count = if length == 0 { 0 } else { end - start + 1 };
    let mut data = Vec::new();
    if request.method() == tauri::http::Method::GET {
        if file.seek(SeekFrom::Start(start)).is_err() {
            return response(StatusCode::NOT_FOUND, Vec::new());
        }
        let mut limited = file.take(count);
        if limited.read_to_end(&mut data).is_err() || data.len() as u64 != count {
            return response(StatusCode::NOT_FOUND, Vec::new());
        }
    }
    let mut builder = Response::builder()
        .status(if selected.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, metadata.mime)
        .header(header::CONTENT_LENGTH, count.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", "default-src 'none'; sandbox");
    if selected.is_some() {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    builder
        .body(Cow::Owned(data))
        .unwrap_or_else(|_| response(StatusCode::NOT_FOUND, Vec::new()))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "a failed unwrap is a failed protocol test"
)]
mod tests {
    use super::*;

    fn get(library: &Arc<Library>, uri: &str, range: Option<&str>) -> Response<Cow<'static, [u8]>> {
        let mut request = Request::builder().uri(uri);
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        serve(library, request.body(Vec::new()).unwrap())
    }

    #[test]
    fn serves_only_registered_ids_with_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let library = Arc::new(Library::open(&dir.path().join("library.db")).unwrap());
        let begin = library
            .files_upload_begin("main", "a.txt", "text/plain", 6, None)
            .unwrap();
        library
            .files_upload_chunk("main", &begin.upload_id, 0, b"abcdef")
            .unwrap();
        let id = library
            .files_upload_finish("main", &begin.upload_id)
            .unwrap()
            .id;
        std::fs::write(dir.path().join("library.secret"), b"x").unwrap();

        let ok = get(&library, &format!("autonote-file://localhost/{id}"), None);
        assert_eq!(
            (ok.status(), ok.body().as_ref()),
            (StatusCode::OK, &b"abcdef"[..])
        );
        let part = get(
            &library,
            &format!("autonote-file://localhost/{id}"),
            Some("bytes=2-3"),
        );
        assert_eq!(
            (part.status(), part.body().as_ref()),
            (StatusCode::PARTIAL_CONTENT, &b"cd"[..])
        );
        let bad = get(
            &library,
            &format!("autonote-file://localhost/{id}"),
            Some("bytes=9-"),
        );
        assert_eq!(bad.status(), StatusCode::RANGE_NOT_SATISFIABLE);

        for uri in [
            format!("autonote-file://localhost/{id}?x=1"),
            "autonote-file://localhost/../library.secret".to_owned(),
            "autonote-file://localhost/%2e%2e%2flibrary.secret".to_owned(),
            "autonote-file://localhost/a/b".to_owned(),
            "autonote-file://localhost/01arz3ndektsv4rrffq69g5fav".to_owned(),
        ] {
            assert_eq!(
                get(&library, &uri, None).status(),
                StatusCode::NOT_FOUND,
                "{uri}"
            );
        }
    }

    #[test]
    fn open_range_is_capped_and_reports_the_true_slice() {
        let dir = tempfile::tempdir().unwrap();
        let library = Arc::new(Library::open(&dir.path().join("library.db")).unwrap());
        let size = MAX_SLICE + 10;
        let begin = library
            .files_upload_begin("main", "v.bin", "", size, None)
            .unwrap();
        let chunk = vec![7u8; note_core::CHUNK_MAX_BYTES];
        let mut offset = 0;
        while offset < size {
            let n = (size - offset).min(chunk.len() as u64) as usize;
            offset = library
                .files_upload_chunk("main", &begin.upload_id, offset, &chunk[..n])
                .unwrap();
        }
        let id = library
            .files_upload_finish("main", &begin.upload_id)
            .unwrap()
            .id;
        let part = get(
            &library,
            &format!("autonote-file://localhost/{id}"),
            Some("bytes=0-"),
        );
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.body().len() as u64, MAX_SLICE);
        assert_eq!(
            part.headers()[header::CONTENT_RANGE],
            format!("bytes 0-{}/{size}", MAX_SLICE - 1).as_str()
        );
        let full = get(&library, &format!("autonote-file://localhost/{id}"), None);
        assert_eq!(
            full.body().len() as u64,
            size,
            "un-ranged GET stays whole for <img>"
        );
    }
}
