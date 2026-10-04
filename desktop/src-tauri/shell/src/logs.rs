//! Bounded log reader for the desktop log viewer.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

const TAIL_BYTES: u64 = 256 * 1024;
const MAX_LIMIT: usize = 2000;

/// One parsed tracing line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub seq: usize,
    pub time: String,
    pub level: String,
    pub target: String,
    pub message: String,
}

fn parse_line(seq: usize, line: &str) -> LogEntry {
    let fallback = || LogEntry {
        seq,
        time: String::new(),
        level: "INFO".to_string(),
        target: String::new(),
        message: line.to_string(),
    };
    let Some(separator) = line.find(char::is_whitespace) else {
        return fallback();
    };
    let time = &line[..separator];
    if !time.ends_with('Z') {
        return fallback();
    }
    let rest = line[separator..].trim_start();
    let Some(separator) = rest.find(char::is_whitespace) else {
        return fallback();
    };
    let level = &rest[..separator];
    if !matches!(level, "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE") {
        return fallback();
    }
    let rest = rest[separator..].trim_start();
    let (target, message) = rest.split_once(": ").unwrap_or((rest, ""));
    LogEntry {
        seq,
        time: time.to_string(),
        level: level.to_string(),
        target: target.to_string(),
        message: message.to_string(),
    }
}

/// Returns up to `limit` complete lines, oldest first, from the bounded tail.
/// Missing files return an empty list. `limit` is capped at 2000.
///
/// # Errors
/// Returns the underlying I/O error if an existing log cannot be opened or read.
pub fn tail(path: &Path, limit: usize) -> io::Result<Vec<LogEntry>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let size = file.metadata()?.len();
    let from = size.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(from))?;
    let mut buffer = Vec::with_capacity((size - from) as usize);
    // The snapshot length prevents an append-heavy writer from making this read unbounded.
    file.take(size - from).read_to_end(&mut buffer)?;
    let truncated_start = from > 0;
    let text = String::from_utf8_lossy(&buffer);
    let mut lines: Vec<&str> = text.split('\n').collect();
    // Drop the final empty segment or unfinished line during a concurrent write.
    lines.pop();
    if truncated_start && !lines.is_empty() {
        lines.remove(0);
    }
    let limit = limit.min(MAX_LIMIT);
    let start = lines.len().saturating_sub(limit);
    Ok(lines[start..]
        .iter()
        .enumerate()
        .map(|(index, line)| parse_line(index, line))
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
mod tests {
    use super::*;

    #[test]
    fn padded_levels_and_malformed_lines_are_kept() {
        let entry = parse_line(
            0,
            "2026-09-23T02:37:59.100951Z  WARN target::module: message",
        );
        assert_eq!(entry.level, "WARN");
        assert_eq!(entry.target, "target::module");
        assert_eq!(parse_line(1, "malformed").message, "malformed");
    }

    #[test]
    fn bounded_tail_handles_utf8_and_truncated_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("autonote.log");
        let prefix = vec![b'x'; TAIL_BYTES as usize];
        std::fs::write(
            &path,
            [prefix, "\n完整\nmalformed\ntruncated".as_bytes().to_vec()].concat(),
        )
        .unwrap();
        let entries = tail(&path, 10).unwrap();
        let messages: Vec<_> = entries.iter().map(|entry| entry.message.as_str()).collect();
        assert_eq!(messages, ["完整", "malformed"]);
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            tail(&dir.path().join("missing.log"), 300)
                .unwrap()
                .is_empty()
        );
    }
}
