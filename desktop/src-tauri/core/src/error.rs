//! Kernel error (`Error`) and its IPC/MCP wire format (`AppError`).
//!
//! Functions inside the crate return [`Error`], whose variants name the cause.
//! [`AppError`] is only built at an entry boundary through `From<Error>`; it
//! carries an [`ErrorCode`] from 02 §5 and safe structured `details`.
//! Callers branch on `code`, never on `message`.
//!
//! Nothing from SQLite or the file system reaches the client: SQL text, paths
//! and driver messages stay inside `Error`. `AppError` keeps at most a numeric
//! cause (SQLite extended code or `io::ErrorKind`) for its `Display`, which the
//! command layer logs, and never serializes it.

use std::fmt;

use serde::Serialize;

use crate::dto::Note;
use crate::types::{Cursor, Rev};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Entity {
    Note,
    Folder,
    Tag,
    Attachment,
    Version,
}

impl Entity {
    const fn label(self) -> &'static str {
        match self {
            Self::Note => "Note",
            Self::Folder => "Folder",
            Self::Tag => "Tag",
            Self::Attachment => "Attachment",
            Self::Version => "Version",
        }
    }
}

/// Failure inside `note-core`, split by cause.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Caller input broke a rule. `field` is the camelCase input name.
    #[error("{field} {reason}")]
    InvalidInput {
        field: &'static str,
        reason: &'static str,
    },
    /// No live record with this ID.
    #[error("{} {id} not found", entity.label())]
    NotFound { entity: Entity, id: String },
    /// The note is gone; `deletion_cursor` is the local `changes.seq` of its
    /// deletion, if one was recorded (worker `routes/notes.ts` line 361).
    #[error("note not found (deletion cursor {deletion_cursor:?})")]
    NoteGone { deletion_cursor: Option<Cursor> },
    /// The caller's local rev is stale; `server` is the current note.
    #[error("note rev conflict: expected {expected}, current {}", server.summary.rev)]
    Conflict { expected: Rev, server: Box<Note> },
    /// An ID or unique name is already taken.
    #[error("{} already exists", entity.label())]
    Duplicate { entity: Entity },
    /// `field` exceeds `limit` (in the unit `LIMITS` defines for it).
    #[error("{field} exceeds the limit of {limit}")]
    TooLarge { field: &'static str, limit: u64 },
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// The library file was written by a newer build.
    #[error("library schema v{found} is newer than this build (v{supported})")]
    SchemaTooNew { found: i64, supported: i64 },
    /// A lock holder panicked; the protected state may be inconsistent.
    #[error("library lock poisoned")]
    Poisoned,
    /// A network-backed operation found no connectivity.
    #[error("offline")]
    Offline,
    /// The caller cancelled the job before it committed.
    #[error("cancelled")]
    Cancelled,
}

impl Error {
    /// Shorthand for [`Error::InvalidInput`].
    #[must_use]
    pub const fn invalid(field: &'static str, reason: &'static str) -> Self {
        Self::InvalidInput { field, reason }
    }
}

impl<T> From<std::sync::PoisonError<T>> for Error {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        Self::Poisoned
    }
}

/// Machine-readable code, the 02 §5 set plus the client-only codes of 10 §2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    Unauthenticated,
    Forbidden,
    NotFound,
    Conflict,
    PayloadTooLarge,
    TooManyAttempts,
    StorageUnavailable,
    Internal,
    Offline,
    Cancelled,
    RequestTimeout,
    InvalidResponse,
}

impl ErrorCode {
    /// Wire spelling, identical to the TS `ErrorCode` literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "bad_request",
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::PayloadTooLarge => "payload_too_large",
            Self::TooManyAttempts => "too_many_attempts",
            Self::StorageUnavailable => "storage_unavailable",
            Self::Internal => "internal",
            Self::Offline => "offline",
            Self::Cancelled => "cancelled",
            Self::RequestTimeout => "request_timeout",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Safe structured `details`. Each variant serializes to a flat object.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum ErrorDetails {
    /// `bad_request`: which input field was rejected.
    Field {
        field: &'static str,
    },
    /// MCP-specific machine-readable reason.
    Reason {
        reason: &'static str,
    },
    Deletion {
        deletion_cursor: Option<Cursor>,
    },
    /// `conflict` on a local note rev. `server` matches worker
    /// `{ server: Note }`; `resource/id/expected/actual` serve MCP (22 §3.1).
    NoteConflict {
        resource: Entity,
        id: String,
        expected: Rev,
        actual: Rev,
        server: Box<Note>,
    },
    /// `conflict` on a taken ID or name.
    Resource {
        resource: Entity,
    },
}

/// IPC/MCP wire error: `{ code, message, details? }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppError {
    code: ErrorCode,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<ErrorDetails>,
    /// Numeric diagnostic for logs only; never serialized.
    #[serde(skip)]
    cause: Option<Cause>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cause {
    Sqlite(i32),
    Io(std::io::ErrorKind),
    Schema { found: i64, supported: i64 },
}

impl AppError {
    /// Error raised by an entry point itself (not by the kernel), e.g. a
    /// failed blocking task. `message` must not contain paths or user data.
    #[must_use]
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
            cause: None,
        }
    }

    /// Code callers branch on.
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    /// Human-readable English text; not a contract.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Structured details, if the code defines any.
    #[must_use]
    pub const fn details(&self) -> Option<&ErrorDetails> {
        self.details.as_ref()
    }

    pub fn with_details(mut self, details: ErrorDetails) -> Self {
        self.details = Some(details);
        self
    }

    fn with_cause(mut self, cause: Cause) -> Self {
        self.cause = Some(cause);
        self
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)?;
        match self.cause {
            Some(Cause::Sqlite(code)) => write!(f, " (sqlite code {code})"),
            Some(Cause::Io(kind)) => write!(f, " (io {kind:?})"),
            Some(Cause::Schema { found, supported }) => {
                write!(f, " (schema v{found} > v{supported})")
            }
            None => Ok(()),
        }
    }
}

impl std::error::Error for AppError {}

/// `storage_unavailable` when the store cannot be used right now (busy,
/// locked, full, read-only, unopenable), otherwise `internal`. The message is
/// fixed text so no driver output, SQL or path can leak through it.
fn storage_or_internal(is_storage: bool) -> AppError {
    if is_storage {
        AppError::new(
            ErrorCode::StorageUnavailable,
            "Local storage is unavailable",
        )
    } else {
        AppError::new(ErrorCode::Internal, "Internal error")
    }
}

fn sqlite_is_storage(code: rusqlite::ErrorCode) -> bool {
    use rusqlite::ErrorCode as C;
    matches!(
        code,
        C::DatabaseBusy
            | C::DatabaseLocked
            | C::DiskFull
            | C::CannotOpen
            | C::ReadOnly
            | C::PermissionDenied
            | C::SystemIoFailure
    )
}

fn io_is_storage(kind: std::io::ErrorKind) -> bool {
    use std::io::ErrorKind as K;
    matches!(
        kind,
        K::NotFound
            | K::PermissionDenied
            | K::StorageFull
            | K::ReadOnlyFilesystem
            | K::ResourceBusy
            | K::QuotaExceeded
    )
}

fn from_sqlite(error: &rusqlite::Error) -> AppError {
    match error.sqlite_error() {
        Some(failure) => storage_or_internal(sqlite_is_storage(failure.code))
            .with_cause(Cause::Sqlite(failure.extended_code)),
        None => storage_or_internal(false),
    }
}

impl From<Error> for AppError {
    fn from(error: Error) -> Self {
        match error {
            Error::InvalidInput { field, reason } => {
                Self::new(ErrorCode::BadRequest, format!("{field} {reason}"))
                    .with_details(ErrorDetails::Field { field })
            }
            Error::NotFound { entity, .. } => {
                Self::new(ErrorCode::NotFound, format!("{} not found", entity.label()))
            }
            Error::NoteGone { deletion_cursor } => Self::new(ErrorCode::NotFound, "Note not found")
                .with_details(ErrorDetails::Deletion { deletion_cursor }),
            Error::Conflict { expected, server } => {
                Self::new(ErrorCode::Conflict, "This note was modified elsewhere").with_details(
                    ErrorDetails::NoteConflict {
                        resource: Entity::Note,
                        id: server.summary.id.as_str().to_owned(),
                        expected,
                        actual: server.summary.rev,
                        server,
                    },
                )
            }
            Error::Duplicate { entity } => Self::new(
                ErrorCode::Conflict,
                format!("{} already exists", entity.label()),
            )
            .with_details(ErrorDetails::Resource { resource: entity }),
            Error::TooLarge { field, limit } => Self::new(
                ErrorCode::PayloadTooLarge,
                format!("{field} exceeds the limit of {limit}"),
            ),
            Error::Sqlite(source) => from_sqlite(&source),
            Error::Io(source) => {
                let kind = source.kind();
                storage_or_internal(io_is_storage(kind)).with_cause(Cause::Io(kind))
            }
            Error::SchemaTooNew { found, supported } => Self::new(
                ErrorCode::Internal,
                "The library was created by a newer AutoNote version",
            )
            .with_cause(Cause::Schema { found, supported }),
            Error::Poisoned => storage_or_internal(false),
            Error::Offline => Self::new(ErrorCode::Offline, "Network is unreachable"),
            Error::Cancelled => Self::new(ErrorCode::Cancelled, "The operation was cancelled"),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::dto::test_note;

    fn wire(error: Error) -> Value {
        serde_json::to_value(AppError::from(error)).unwrap()
    }

    /// Every string anywhere in the serialized error, for leak checks.
    fn all_text(value: &Value) -> String {
        match value {
            Value::String(text) => text.clone(),
            Value::Array(items) => items.iter().map(all_text).collect::<Vec<_>>().join(" "),
            Value::Object(map) => map
                .iter()
                .map(|(k, v)| format!("{k} {}", all_text(v)))
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        }
    }

    #[test]
    fn codes_serialize_to_the_shared_error_code_literals() {
        let expected = [
            (ErrorCode::BadRequest, "bad_request"),
            (ErrorCode::Unauthenticated, "unauthenticated"),
            (ErrorCode::Forbidden, "forbidden"),
            (ErrorCode::NotFound, "not_found"),
            (ErrorCode::Conflict, "conflict"),
            (ErrorCode::PayloadTooLarge, "payload_too_large"),
            (ErrorCode::TooManyAttempts, "too_many_attempts"),
            (ErrorCode::StorageUnavailable, "storage_unavailable"),
            (ErrorCode::Internal, "internal"),
            (ErrorCode::Offline, "offline"),
            (ErrorCode::Cancelled, "cancelled"),
            (ErrorCode::RequestTimeout, "request_timeout"),
            (ErrorCode::InvalidResponse, "invalid_response"),
        ];
        for (code, literal) in expected {
            assert_eq!(serde_json::to_value(code).unwrap(), json!(literal));
            assert_eq!(code.as_str(), literal);
        }
    }

    #[test]
    fn invalid_input_is_bad_request_with_the_field() {
        let value = wire(Error::invalid("rev", "must be a positive integer"));
        assert_eq!(value["code"], "bad_request");
        assert_eq!(value["details"], json!({ "field": "rev" }));
    }

    #[test]
    fn note_conflict_carries_the_server_note_and_both_revs() {
        let server = test_note(4);
        let value = wire(Error::Conflict {
            expected: Rev::new(3).unwrap(),
            server: Box::new(server.clone()),
        });
        assert_eq!(value["code"], "conflict");
        let details = &value["details"];
        assert_eq!(details["resource"], "note");
        assert_eq!(details["id"], json!(server.summary.id.as_str()));
        assert_eq!(details["expected"], 3);
        assert_eq!(details["actual"], 4);
        assert_eq!(details["server"], serde_json::to_value(&server).unwrap());
        assert_eq!(details["server"]["content"], json!(server.content));
    }

    #[test]
    fn duplicate_is_a_conflict_without_a_server_note() {
        let value = wire(Error::Duplicate {
            entity: Entity::Tag,
        });
        assert_eq!(value["code"], "conflict");
        assert_eq!(value["details"], json!({ "resource": "tag" }));
    }

    #[test]
    fn missing_note_reports_its_deletion_cursor_or_null() {
        let gone = wire(Error::NoteGone {
            deletion_cursor: Some(Cursor::new(42).unwrap()),
        });
        assert_eq!(gone["code"], "not_found");
        assert_eq!(gone["details"], json!({ "deletionCursor": 42 }));

        let never = wire(Error::NoteGone {
            deletion_cursor: None,
        });
        assert_eq!(never["details"], json!({ "deletionCursor": null }));

        let folder = wire(Error::NotFound {
            entity: Entity::Folder,
            id: "x".to_owned(),
        });
        assert_eq!(folder["code"], "not_found");
        assert!(folder.get("details").is_none());
    }

    #[test]
    fn too_large_is_payload_too_large() {
        let value = wire(Error::TooLarge {
            field: "content",
            limit: 2_097_152,
        });
        assert_eq!(value["code"], "payload_too_large");
    }

    #[test]
    fn sqlite_failure_does_not_leak_sql_or_driver_text() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let source = conn
            .execute("SELECT secret_column FROM private_table", [])
            .unwrap_err();
        let raw = source.to_string();
        assert!(
            raw.contains("private_table"),
            "precondition: driver text names the table"
        );

        let error = AppError::from(Error::Sqlite(source));
        assert_eq!(error.code(), ErrorCode::Internal);
        let value = serde_json::to_value(&error).unwrap();
        let text = all_text(&value);
        assert!(
            !text.contains("private_table") && !text.contains("secret_column"),
            "{text}"
        );
        assert!(!error.to_string().contains("private_table"));
        assert_eq!(
            value.as_object().unwrap().len(),
            2,
            "only code and message: {value}"
        );
    }

    #[test]
    fn busy_database_is_storage_unavailable() {
        let source = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(5),
            Some("database is locked".to_owned()),
        );
        assert_eq!(
            AppError::from(Error::Sqlite(source)).code(),
            ErrorCode::StorageUnavailable
        );
    }

    #[test]
    fn io_failure_does_not_leak_the_path() {
        let path = r"C:\Users\someone\AutoNote\data\files\01hzx3k8m9n0p1q2r3s4t5v6w7";
        let denied = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("access denied: {path}"),
        );
        let error = AppError::from(Error::Io(denied));
        assert_eq!(error.code(), ErrorCode::StorageUnavailable);
        let text = all_text(&serde_json::to_value(&error).unwrap());
        assert!(
            !text.contains("someone") && !text.contains(r"data\files"),
            "{text}"
        );
        assert!(!error.to_string().contains("someone"));

        let other = std::io::Error::other(format!("broken pipe at {path}"));
        assert_eq!(AppError::from(Error::Io(other)).code(), ErrorCode::Internal);
    }

    #[test]
    fn schema_and_poison_map_to_internal_without_internal_names() {
        for source in [
            Error::SchemaTooNew {
                found: 9,
                supported: 2,
            },
            Error::Poisoned,
        ] {
            let value = wire(source);
            assert_eq!(value["code"], "internal");
            let text = all_text(&value);
            assert!(
                !text.contains("SCHEMA_TOO_NEW") && !text.contains("SchemaTooNew"),
                "{text}"
            );
            assert!(!text.to_lowercase().contains("poison"), "{text}");
        }
        let poisoned = std::sync::Mutex::new(());
        let _ = std::panic::catch_unwind(|| {
            let _guard = poisoned.lock();
            std::panic::resume_unwind(Box::new("poison the lock"));
        });
        let error = Error::from(poisoned.lock().unwrap_err());
        assert!(matches!(error, Error::Poisoned));
    }

    #[test]
    fn client_only_causes_keep_their_own_codes() {
        assert_eq!(wire(Error::Offline)["code"], "offline");
        assert_eq!(wire(Error::Cancelled)["code"], "cancelled");
    }
}
