//! Bounded runtime logs and a single allowlist at the tracing output boundary.
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use tracing::field::{Field, Visit};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::field::RecordFields;
use tracing_subscriber::fmt::format::{FormatFields, Writer};
use tracing_subscriber::fmt::writer::MakeWriter;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
static AVAILABLE: AtomicBool = AtomicBool::new(false);
static WRITER: OnceLock<RotatingWriter> = OnceLock::new();

/// Whether the latest file write/flush/rotation succeeded.
#[must_use]
pub fn available() -> bool {
    AVAILABLE.load(Ordering::Relaxed)
}

/// Flushes the file writer during orderly shutdown.
/// # Errors
/// Returns unavailable, poisoned-lock or filesystem failures without logging recursively.
pub fn flush() -> io::Result<()> {
    let writer = WRITER
        .get()
        .ok_or_else(|| io::Error::other("logging unavailable"))?;
    let mut state = writer
        .state
        .lock()
        .map_err(|_| io::Error::other("logging lock unavailable"))?;
    let result = state
        .file
        .as_mut()
        .ok_or_else(|| io::Error::other("logging unavailable"))
        .and_then(|file| file.sync_all());
    AVAILABLE.store(result.is_ok(), Ordering::Relaxed);
    result
}

/// Installs a secure tracing formatter; file failure remains a visible diagnostic.
pub fn init(path: &Path) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let opened = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| RotatingWriter::new(path));
    match opened {
        Ok(writer) => {
            let result = tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .fmt_fields(SafeFields)
                .with_writer(writer.clone())
                .try_init();
            AVAILABLE.store(result.is_ok(), Ordering::Relaxed);
            if result.is_ok() {
                let _ = WRITER.set(writer);
            }
        }
        Err(_) => {
            AVAILABLE.store(false, Ordering::Relaxed);
            let _ = tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .fmt_fields(SafeFields)
                .try_init();
        }
    }
}

/// Validates a static dot-separated event name.
#[must_use]
pub fn valid_event(value: &str) -> bool {
    value.len() <= 128
        && value.contains('.')
        && value.split('.').all(|part| {
            part.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
}

/// Shared IPC/tracing field allowlist. Free-form error text, URLs and user text are excluded.
#[must_use]
pub fn safe_field(key: &str, value: &serde_json::Value) -> bool {
    use serde_json::Value;
    match value {
        Value::Number(value) => {
            matches!(
                key,
                "count"
                    | "pending"
                    | "failed"
                    | "pendingCount"
                    | "droppedCount"
                    | "durationMs"
                    | "cursor"
                    | "rev"
                    | "schemaVersion"
                    | "indexed"
                    | "attachmentCount"
                    | "noteCount"
                    | "recoveredCount"
                    | "orphanCount"
                    | "dpi"
                    | "status"
            ) && value.as_f64().is_some_and(f64::is_finite)
        }
        Value::Bool(_) => matches!(key, "online" | "available"),
        Value::String(value) => safe_text(key, value),
        _ => false,
    }
}

fn safe_text(key: &str, value: &str) -> bool {
    match key {
        "event" | "message" => valid_event(value),
        "command" => {
            (1..=64).contains(&value.len())
                && value.as_bytes()[0].is_ascii_lowercase()
                && value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        }
        "code" => matches!(
            value,
            "bad_request"
                | "unauthenticated"
                | "forbidden"
                | "not_found"
                | "conflict"
                | "payload_too_large"
                | "too_many_attempts"
                | "storage_unavailable"
                | "internal"
                | "offline"
                | "cancelled"
                | "request_timeout"
                | "invalid_response"
        ),
        "phase" | "stage" => matches!(
            value,
            "validating"
                | "reading"
                | "writing"
                | "uploading"
                | "finalizing"
                | "startup"
                | "shutdown"
                | "paths"
                | "library"
                | "webview"
                | "logging"
        ),
        "reason" => matches!(
            value,
            "dpi_changed" | "monitor_removed" | "offscreen" | "invalid_state"
        ),
        "format" => matches!(value, "zip" | "json"),
        "noteId" | "note_id" => {
            value.len() == 26
                && value
                    .bytes()
                    .all(|b| b"0123456789abcdefghjkmnpqrstvwxyz".contains(&b))
        }
        "jobId" | "writeId" => {
            value.len() == 36
                && value.bytes().enumerate().all(|(index, byte)| {
                    if matches!(index, 8 | 13 | 18 | 23) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
        }
        "version" => {
            !value.is_empty()
                && value.len() <= 32
                && value.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        }
        _ => false,
    }
}

struct SafeFields;
struct SafeVisitor<'a> {
    writer: Writer<'a>,
    result: fmt::Result,
}
impl<'a> FormatFields<'a> for SafeFields {
    fn format_fields<R: RecordFields>(&self, writer: Writer<'a>, fields: R) -> fmt::Result {
        let mut visitor = SafeVisitor {
            writer,
            result: Ok(()),
        };
        fields.record(&mut visitor);
        visitor.result
    }
}
impl SafeVisitor<'_> {
    fn field(&mut self, name: &str, value: &serde_json::Value) {
        // Flat IPC fields cannot recursively re-enter their own JSON container.
        if self.result.is_err() {
            return;
        }
        if safe_field(name, value) {
            self.result = if name == "message" {
                write!(self.writer, "{} ", value.as_str().unwrap_or_default())
            } else {
                write!(self.writer, "{name}={value} ")
            };
        } else if name == "fields"
            && let Some(fields) =
                value
                    .as_str()
                    .filter(|text| text.len() <= 4096)
                    .and_then(|text| {
                        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(text)
                            .ok()
                    })
        {
            for (key, value) in fields {
                if key != "fields" {
                    self.field(&key, &value);
                }
            }
        }
    }
}
impl Visit for SafeVisitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        if self.result.is_err() {
            return;
        }
        if safe_text(field.name(), value) {
            self.result = if field.name() == "message" {
                write!(self.writer, "{value} ")
            } else {
                write!(self.writer, "{}={value:?} ", field.name())
            };
        } else if field.name() == "fields" {
            self.field("fields", &value.into());
        }
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.field(field.name(), &value.into());
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.field(field.name(), &value.into());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.field(field.name(), &serde_json::json!(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.field(field.name(), &value.into());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        // Error/source debug formatting can contain plaintext secrets; never evaluate it.
        if matches!(
            field.name(),
            "message"
                | "event"
                | "fields"
                | "version"
                | "code"
                | "noteId"
                | "note_id"
                | "jobId"
                | "writeId"
                | "reason"
                | "phase"
                | "stage"
                | "format"
        ) {
            let text = format!("{value:?}");
            self.record_str(field, text.trim_matches('"'));
        }
    }
}

#[derive(Clone)]
struct RotatingWriter {
    state: Arc<Mutex<WriterState>>,
}
struct WriterState {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
}
struct RotatingGuard<'a> {
    state: Option<MutexGuard<'a, WriterState>>,
}
impl RotatingWriter {
    fn new(path: &Path) -> io::Result<Self> {
        let file = open_log(path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            state: Arc::new(Mutex::new(WriterState {
                path: path.to_path_buf(),
                file: Some(file),
                bytes,
            })),
        })
    }
}
impl<'a> MakeWriter<'a> for RotatingWriter {
    type Writer = RotatingGuard<'a>;
    fn make_writer(&'a self) -> Self::Writer {
        let state = self.state.lock().ok();
        if state.is_none() {
            AVAILABLE.store(false, Ordering::Relaxed);
        }
        RotatingGuard { state }
    }
}
impl WriterState {
    fn rotate(&mut self) -> io::Result<()> {
        drop(self.file.take()); // Windows requires the handle closed before rename.
        for number in (1..=2).rev() {
            let source = if number == 1 {
                self.path.clone()
            } else {
                rotated_path(&self.path, number - 1)
            };
            let destination = rotated_path(&self.path, number);
            match std::fs::remove_file(&destination) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            match std::fs::rename(source, destination) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        self.file = Some(open_log(&self.path)?);
        self.bytes = 0;
        Ok(())
    }
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.file.is_none() {
            let file = open_log(&self.path)?;
            self.bytes = file.metadata()?.len();
            self.file = Some(file);
        }
        if self.bytes >= MAX_LOG_BYTES
            || (buffer.len() as u64 <= MAX_LOG_BYTES
                && self.bytes + buffer.len() as u64 > MAX_LOG_BYTES)
        {
            self.rotate()?;
        }
        let room = (MAX_LOG_BYTES - self.bytes) as usize;
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("logging unavailable"))?;
        let written = file.write(&buffer[..buffer.len().min(room)])?;
        self.bytes += written as u64;
        Ok(written)
    }
}
impl Write for RotatingGuard<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let result = self
            .state
            .as_mut()
            .ok_or_else(|| io::Error::other("logging lock unavailable"))
            .and_then(|state| state.write(buffer));
        AVAILABLE.store(result.is_ok(), Ordering::Relaxed);
        result
    }
    fn flush(&mut self) -> io::Result<()> {
        let result = self
            .state
            .as_mut()
            .and_then(|state| state.file.as_mut())
            .ok_or_else(|| io::Error::other("logging unavailable"))
            .and_then(File::flush);
        AVAILABLE.store(result.is_ok(), Ordering::Relaxed);
        result
    }
}
fn open_log(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}
fn rotated_path(path: &Path, number: u8) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{number}"));
    path.with_file_name(name)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "failed unwrap fails test")]
mod tests {
    use super::*;
    #[test]
    fn runtime_rotation_is_bounded_and_ordered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("autonote.log");
        let writer = RotatingWriter::new(&path).unwrap();
        for byte in [b'a', b'b', b'c'] {
            writer
                .make_writer()
                .write_all(&vec![byte; MAX_LOG_BYTES as usize])
                .unwrap();
        }
        assert_eq!(std::fs::read(&path).unwrap()[0], b'c');
        assert_eq!(std::fs::read(rotated_path(&path, 1)).unwrap()[0], b'b');
        assert_eq!(std::fs::read(rotated_path(&path, 2)).unwrap()[0], b'a');
        assert!(!rotated_path(&path, 3).exists());
        writer.make_writer().write_all(b"overflow").unwrap();
        for name in [&path, &rotated_path(&path, 1), &rotated_path(&path, 2)] {
            assert!(std::fs::metadata(name).unwrap().len() <= MAX_LOG_BYTES);
        }
        let blocked = tempfile::tempdir().unwrap();
        let blocked_path = blocked.path().join("autonote.log");
        let blocked_writer = RotatingWriter::new(&blocked_path).unwrap();
        blocked_writer
            .make_writer()
            .write_all(&vec![b'x'; MAX_LOG_BYTES as usize])
            .unwrap();
        std::fs::create_dir(rotated_path(&blocked_path, 2)).unwrap();
        assert!(
            blocked_writer
                .make_writer()
                .write_all(b"cannot rotate")
                .is_err()
        );
    }
    #[test]
    fn tracing_boundary_drops_errors_credentials_and_free_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("autonote.log");
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .fmt_fields(SafeFields)
            .with_writer(RotatingWriter::new(&path).unwrap())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(
                error = "token-secret",
                title = "private title",
                reason = "password",
                code = "conflict",
                count = 3,
                "app.shutdown.failed"
            );
            tracing::info!("https://user:password@example.test/?token=secret");
        });
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.contains("app.shutdown.failed"));
        assert!(text.contains("conflict"));
        for secret in ["token-secret", "private title", "password", "https://"] {
            assert!(!text.contains(secret));
        }
    }
}
