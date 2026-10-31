#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
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
    assert!(raw.contains("private_table"));

    let error = AppError::from(Error::Sqlite(source));
    assert_eq!(error.code(), ErrorCode::Internal);
    let value = serde_json::to_value(&error).unwrap();
    let text = all_text(&value);
    assert!(!text.contains("private_table") && !text.contains("secret_column"));
    assert!(!error.to_string().contains("private_table"));
    assert_eq!(value.as_object().unwrap().len(), 2);
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
    assert!(!text.contains("someone") && !text.contains(r"data\files"));
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
        assert!(!text.contains("SCHEMA_TOO_NEW") && !text.contains("SchemaTooNew"));
        assert!(!text.to_lowercase().contains("poison"));
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
