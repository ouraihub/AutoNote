//! Builds `desktop/fixtures/ipc-contract.json` from a real `Library` through
//! the public API only, and fails when the committed file drifts.
//! Regenerate (from `desktop/`): `UPDATE_FIXTURES=1 node scripts/cargo.mjs test -p note-core --test ipc_contract`.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "fixture generator")]

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use note_core::{
    AppError, ChangeSet, ChangeSink, Clock, Cursor, Error, IdSource, Library, LibraryDeps, Millis,
    NewNote, NotePatch, NoteWriteResult, WriteEvent, WriteOrigin, parse_input,
};
use serde_json::{Value, json};

struct Ticks(AtomicI64);
impl Clock for Ticks {
    fn now(&self) -> Result<Millis, Error> {
        Millis::new(self.0.fetch_add(1, Ordering::Relaxed))
    }
}

/// Deterministic IDs: the random bytes are replaced by a counter.
struct Seq(AtomicI64);
impl IdSource for Seq {
    fn new_id(&self, now: Millis, _: &[u8; 16]) -> String {
        let mut random = [0u8; 16];
        random[8..].copy_from_slice(&self.0.fetch_add(1, Ordering::Relaxed).to_be_bytes());
        note_core::id::encode_id(now.get() as u64, &random)
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<Value>>);
impl ChangeSink for Events {
    fn library_changed(&self, _: ChangeSet) {}
    fn write_event(&self, event: WriteEvent) {
        self.0
            .lock()
            .unwrap()
            .push(serde_json::to_value(event).unwrap());
    }
}

fn wire<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap()
}
fn err<T>(result: Result<T, Error>) -> Value {
    wire(AppError::from(result.err().expect("expected an error")))
}

#[test]
fn ipc_contract_fixture_matches_real_library() {
    let dir = tempfile::tempdir().unwrap();
    let events = Arc::new(Events::default());
    let lib = Library::open_in_memory(
        dir.path(),
        LibraryDeps {
            clock: Arc::new(Ticks(AtomicI64::new(1_700_000_000_000))),
            ids: Arc::new(Seq(AtomicI64::new(1))),
            sink: events.clone(),
        },
    )
    .unwrap();
    let ui = WriteOrigin::Ui;
    let body = |v: Value| -> NewNote {
        NewNote::from(parse_input::<note_core::CreateNoteBody>(v).unwrap())
    };

    let folder = lib
        .create_folder(&parse_input(json!({})).unwrap(), ui)
        .unwrap()
        .value;
    let tag = lib
        .create_tag(
            &parse_input(json!({ "name": "idea", "color": "#dc2626" })).unwrap(),
            ui,
        )
        .unwrap()
        .value;
    let start = lib.notes_snapshot().unwrap();
    let note = lib
        .create_note(&body(json!({ "title": "Alpha", "content": "Hello #idea [[Beta]]", "folderId": folder.id })), ui)
        .unwrap()
        .value;
    let patch = NotePatch::from(
        parse_input::<note_core::PatchNoteBody>(json!({ "rev": 1, "title": "Alpha 2" })).unwrap(),
    );
    let saved = lib
        .patch_note_with_write_id(&note.summary.id, &patch, "w-1", ui)
        .unwrap()
        .value;
    let stale = lib.patch_note_with_write_id(&note.summary.id, &patch, "w-2", ui);
    let copy = lib
        .duplicate_note(&note.summary.id, None, ui)
        .unwrap()
        .value;
    let trashed = lib.trash_note(&copy.summary.id, ui).unwrap().value;
    let purged = lib.purge_note(&copy.summary.id, ui).unwrap().value;
    let incremental = lib.library_changes(start.cursor).unwrap();

    let begin = lib
        .files_upload_begin("main", "a.txt", "text/plain", 3, None)
        .unwrap();
    let received = lib
        .files_upload_chunk("main", &begin.upload_id, 0, b"abc")
        .unwrap();
    let wrong_offset = lib.files_upload_chunk("main", &begin.upload_id, 0, b"x");
    let attachment = lib.files_upload_finish("main", &begin.upload_id).unwrap();
    let reused = lib.files_upload_finish("main", &begin.upload_id);

    let fixture = json!({
        "note": saved.clone(),
        "noteWriteResult": wire(NoteWriteResult { write_id: "w-1".into(), note: saved }),
        "trashed": trashed,
        "purge": { "ok": true, "cursor": purged },
        "folder": folder,
        "tag": tag,
        "syncResponse": {
            "snapshot": start,
            "incremental": incremental,
            "staleSince": lib.library_changes(Cursor::new(0).unwrap()).unwrap(),
        },
        "writeEvents": events.0.lock().unwrap().clone(),
        "upload": {
            "begin": { "uploadId": "<random>", "chunkMaxBytes": begin.chunk_max_bytes },
            "chunk": { "received": received },
            "wrongOffset": err(wrong_offset),
            "finish": attachment,
            "reusedUploadId": err(reused),
            "page": lib.files_list(None).unwrap(),
        },
        "errors": {
            "conflict": err(stale),
            "badRequest": err(lib.create_folder(&parse_input(json!({ "color": "#000000" })).unwrap(), ui)),
            "malformedBody": err(parse_input::<note_core::FolderCreate>(json!({ "nope": 1 }))),
            "notFoundWithDeletionCursor": err(lib.get_note(&copy.summary.id)),
            "duplicateName": err(lib.create_tag(&parse_input(json!({ "name": "IDEA" })).unwrap(), ui)),
            "restoreLiveNote": err(lib.restore_note(&note.summary.id, ui)),
        },
    });

    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/ipc-contract.json");
    let text = serde_json::to_string_pretty(&fixture).unwrap() + "\n";
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, text).unwrap();
        return;
    }
    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).expect("run with UPDATE_FIXTURES=1 first"),
    )
    .unwrap();
    assert_eq!(
        committed, fixture,
        "ipc-contract.json drifted; regenerate and review the diff"
    );
}
