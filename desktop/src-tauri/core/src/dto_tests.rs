#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
use serde_json::{Value, json};

use super::*;
use crate::error::{AppError, ErrorCode};

const ID: &str = "01hzx3k8m9n0p1q2r3s4t5v6w7";

fn rejected<T: DeserializeOwned + std::fmt::Debug>(value: serde_json::Value) {
    let error = AppError::from(parse_input::<T>(value.clone()).unwrap_err());
    assert_eq!(error.code(), ErrorCode::BadRequest, "{value}");
}

#[test]
fn note_serializes_with_the_shared_field_set() {
    let value = serde_json::to_value(test_note(3)).unwrap();
    let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    let mut expected = vec![
        "id", "title", "excerpt", "folderId", "tags", "isPinned", "isStarred",
        "isArchived", "wordCount", "charCount", "rev", "position", "createdAt",
        "updatedAt", "deletedAt", "content",
    ];
    expected.sort_unstable();
    assert_eq!(keys, expected);
    assert_eq!(value["folderId"], json!(null));
    assert_eq!(value["deletedAt"], json!(null));
    assert_eq!(value["rev"], 3);
    assert_eq!(value["createdAt"], 1_700_000_000_000_i64);
}

#[test]
fn note_round_trips_and_rejects_invalid_numbers() {
    let note = test_note(2);
    let value = serde_json::to_value(&note).unwrap();
    assert_eq!(serde_json::from_value::<Note>(value.clone()).unwrap(), note);

    let mut bad_rev = value.clone();
    bad_rev["rev"] = json!(0);
    assert!(serde_json::from_value::<Note>(bad_rev).is_err());
    let mut bad_time = value;
    bad_time["updatedAt"] = json!(-1);
    assert!(serde_json::from_value::<Note>(bad_time).is_err());
}

#[test]
fn write_result_is_always_the_committed_variant() {
    let value = serde_json::to_value(NoteWriteResult {
        write_id: "w1".to_owned(),
        note: test_note(5),
    })
    .unwrap();
    assert_eq!(value["queued"], json!(false));
    assert_eq!(value["writeId"], "w1");
    assert_eq!(value["note"]["rev"], 5);
}

#[test]
fn optional_folder_fields_are_omitted_and_nullable_ones_are_null() {
    let folder = Folder {
        id: ID.parse().unwrap(),
        parent_id: None,
        name: "Inbox".to_owned(),
        icon: None,
        color: None,
        position: 1.5,
        created_at: Millis::new(1).unwrap(),
        updated_at: Millis::new(2).unwrap(),
        note_count: None,
    };
    let value = serde_json::to_value(&folder).unwrap();
    assert!(value.get("noteCount").is_none());
    assert_eq!(value["parentId"], json!(null));
    assert_eq!(value["icon"], json!(null));
}

#[test]
fn progress_and_deletion_enums_use_the_shared_literals() {
    let event = ProgressEvent {
        job_id: "j".to_owned(),
        phase: ProgressPhase::Finalizing,
        completed: 3,
        total: None,
        terminal: true,
    };
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "jobId": "j",
            "phase": "finalizing",
            "completed": 3,
            "total": null,
            "terminal": true
        })
    );
    let deletion = SyncDeletion {
        entity: DeletedEntity::Folder,
        id: ID.to_owned(),
    };
    assert_eq!(
        serde_json::to_value(deletion).unwrap(),
        json!({ "entity": "folder", "id": ID })
    );
}

#[test]
fn patch_body_distinguishes_absent_and_null_folder() {
    let absent: PatchNoteBody = parse_input(json!({ "rev": 2 })).unwrap();
    assert_eq!(absent.folder_id, None);
    let cleared: PatchNoteBody = parse_input(json!({ "rev": 2, "folderId": null })).unwrap();
    assert_eq!(cleared.folder_id, Some(None));
    let moved: PatchNoteBody = parse_input(json!({ "rev": 2, "folderId": ID })).unwrap();
    assert_eq!(moved.folder_id.unwrap().unwrap().as_str(), ID);
    assert_eq!(moved.rev.get(), 2);
}

#[test]
fn malformed_bodies_are_bad_request() {
    rejected::<PatchNoteBody>(json!({}));
    rejected::<PatchNoteBody>(json!({ "rev": 0 }));
    rejected::<PatchNoteBody>(json!({ "rev": -3 }));
    rejected::<PatchNoteBody>(json!({ "rev": 1.5 }));
    rejected::<PatchNoteBody>(json!({ "rev": "1" }));
    rejected::<PatchNoteBody>(json!({ "rev": 1, "folderId": "NOPE" }));
    rejected::<PatchNoteBody>(json!({ "rev": 1, "isPinned": "yes" }));
    rejected::<PatchNoteBody>(json!({ "rev": 1, "unknown": true }));
    rejected::<CreateNoteBody>(json!({ "id": "../etc/passwd" }));
    rejected::<CreateNoteBody>(json!({ "title": 7 }));
    rejected::<CreateNoteBody>(json!([]));
}

#[test]
fn create_body_accepts_an_empty_object() {
    let body: CreateNoteBody = parse_input(json!({})).unwrap();
    assert_eq!(body, CreateNoteBody::default());
}
