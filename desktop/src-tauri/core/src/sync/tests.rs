#![allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]

use super::*;
use crate::dto::{DeletedEntity, Folder, FolderCreate, Note, SyncDeletion, TagCreate};
use crate::error::Error;
use crate::write::{NewNote, NotePatch, WriteOrigin};
use crate::{Library, LibraryDeps, Millis, RandomIds, Rev};
use rusqlite::{OptionalExtension, params};
use std::sync::Arc;
const A: &str = "01arz3ndektsv4rrffq69g5fa1";
const B: &str = "01arz3ndektsv4rrffq69g5fa2";
const C: &str = "01arz3ndektsv4rrffq69g5fa3";

struct Clock;
impl crate::Clock for Clock {
    fn now(&self) -> Result<Millis, Error> {
        Millis::new(1_700_000_000_000)
    }
}
struct Quiet;
impl crate::ChangeSink for Quiet {
    fn library_changed(&self, _: crate::ChangeSet) {}
    fn write_event(&self, _: crate::WriteEvent) {}
}
fn library() -> Library {
    Library::open_in_memory(
        crate::db::test_files_dir(),
        LibraryDeps {
            clock: Arc::new(Clock),
            ids: Arc::new(RandomIds),
            sink: Arc::new(Quiet),
        },
    )
    .unwrap()
}
fn item(lib: &Library, entity: &str, id: &str) -> Option<(Option<i64>, bool)> {
    lib.conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT remote_rev,dirty FROM sync_item WHERE entity=?1 AND id=?2",
            params![entity, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap()
}
fn dirty(lib: &Library, entity: &str, id: &str) -> bool {
    item(lib, entity, id).is_some_and(|(_, dirty)| dirty)
}
fn trashed(lib: &Library, id: &str) -> bool {
    lib.conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM notes WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}
fn create(lib: &Library, id: &str, content: &str, origin: WriteOrigin) -> Note {
    lib.create_note(
        &NewNote {
            id: Some(id.parse().unwrap()),
            title: Some("T".into()),
            content: content.into(),
            folder_id: None,
            is_starred: false,
        },
        origin,
    )
    .unwrap()
    .value
}
fn edit(lib: &Library, note: &Note, content: &str) -> Note {
    lib.patch_note(
        &note.summary.id,
        &NotePatch {
            rev: note.summary.rev,
            title: None,
            content: Some(content.into()),
            folder_id: None,
            is_pinned: None,
            is_starred: None,
            is_archived: None,
            quiet: false,
            preserve_version: true,
        },
        WriteOrigin::Ui,
    )
    .unwrap()
    .value
}
fn remote(id: &str, rev: i64, content: &str) -> Note {
    let mut note = crate::dto::test_note(rev);
    note.summary.id = id.parse().unwrap();
    note.summary.rev = Rev::new(rev).unwrap();
    note.summary.title = "T".into();
    note.summary.folder_id = None;
    note.summary.deleted_at = None;
    note.content = content.into();
    note
}
fn bind(lib: &Library, snapshot: &RemoteBatch) {
    lib.sync_bind(
        &Binding {
            site_origin: "https://example.test".into(),
            account_hint: "me".into(),
            remote_user_id: "u1".into(),
        },
        &SyncCookie {
            ciphertext: vec![1],
            name: "session".into(),
            domain: "example.test".into(),
            path: "/".into(),
            expires_at: None,
            secure: true,
            host_only: true,
            same_site: "Lax".into(),
        },
        snapshot,
    )
    .unwrap();
}
fn settle_all(lib: &Library) {
    for item in lib.sync_dirty().unwrap() {
        let rev = match &item.row {
            LocalRow::Note(_) => Some(item.remote_rev.unwrap_or(0) + 1),
            _ => item.remote_rev,
        };
        lib.sync_settle(item.entity, &item.id, rev, &item.seen)
            .unwrap();
    }
}

#[test]
fn every_local_write_path_marks_rows_dirty_and_sync_writes_do_not() {
    let lib = library();
    // UI create, edit, copy, trash and empty trash.
    let note = create(&lib, A, "one", WriteOrigin::Ui);
    assert!(dirty(&lib, "note", A));
    settle_all(&lib);
    assert!(!dirty(&lib, "note", A));
    let note = edit(&lib, &note, "two");
    assert!(dirty(&lib, "note", A));
    settle_all(&lib);
    let copy = lib
        .duplicate_note(&note.summary.id, Some(&B.parse().unwrap()), WriteOrigin::Ui)
        .unwrap()
        .value;
    assert!(dirty(&lib, "note", copy.summary.id.as_str()));
    // Version restore.
    let version = lib.list_versions(&note.summary.id).unwrap()[0].id.clone();
    settle_all(&lib);
    let current = lib.get_note(&note.summary.id).unwrap();
    lib.restore_version(
        &note.summary.id,
        &version,
        current.summary.rev,
        WriteOrigin::Ui,
    )
    .unwrap();
    assert!(dirty(&lib, "note", A));
    settle_all(&lib);
    lib.trash_note(&copy.summary.id, WriteOrigin::Ui).unwrap();
    settle_all(&lib);
    lib.empty_trash(WriteOrigin::Ui).unwrap();
    assert!(
        dirty(&lib, "note", B),
        "purged notes stay pending until the remote purge"
    );
    // MCP note and organizer writes.
    settle_all(&lib);
    lib.execute_mcp_write(
        "create_note",
        &serde_json::json!({
            "operation_id": "op-create-1",
            "note_id": C,
            "title": "M",
            "content": "m",
        }),
    )
    .unwrap();
    assert!(dirty(&lib, "note", C));
    let folder = lib
        .create_folder(
            &FolderCreate {
                name: Some("F".into()),
                ..FolderCreate::default()
            },
            WriteOrigin::Mcp,
        )
        .unwrap()
        .value;
    assert!(dirty(&lib, "folder", folder.id.as_str()));
    let tag = lib
        .create_tag(
            &TagCreate {
                id: None,
                name: "x".into(),
                color: None,
            },
            WriteOrigin::Ui,
        )
        .unwrap()
        .value;
    assert!(dirty(&lib, "tag", tag.id.as_str()));
    // Sync-origin writes register nothing.
    settle_all(&lib);
    let before = lib.sync_pending().unwrap();
    lib.create_folder(
        &FolderCreate {
            name: Some("S".into()),
            ..FolderCreate::default()
        },
        WriteOrigin::Sync,
    )
    .unwrap();
    assert_eq!(lib.sync_pending().unwrap(), before);
}

#[test]
fn bind_merges_by_id_and_keeps_both_versions_of_a_differing_note() {
    let lib = library();
    create(&lib, A, "local shared", WriteOrigin::Ui);
    create(&lib, B, "local only", WriteOrigin::Ui);
    let snapshot = RemoteBatch {
        cursor: 7,
        full: true,
        notes: vec![
            remote(A, 3, "remote shared"),
            remote(C, 1, "remote only"),
            remote("01arz3ndektsv4rrffq69g5fa4", 1, "r2"),
        ],
        ..RemoteBatch::default()
    };
    let counts = lib.sync_merge_counts(&snapshot.notes).unwrap();
    assert_eq!(
        counts,
        MergeCounts {
            local_only: 1,
            remote_only: 2,
            same: 0,
            different: 1
        }
    );
    bind(&lib, &snapshot);
    let notes: Vec<(String, String)> = {
        let conn = lib.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id,content FROM notes ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(notes.len(), 5, "4 distinct ids plus one conflict copy");
    assert!(notes.contains(&(A.to_owned(), "remote shared".to_owned())));
    assert!(notes.iter().any(|(id, c)| id != A && c == "local shared"));
    assert_eq!(item(&lib, "note", A), Some((Some(3), false)));
    assert_eq!(item(&lib, "note", B), Some((None, true)));
    assert_eq!(item(&lib, "note", C), Some((Some(1), false)));
    assert_eq!(lib.sync_binding().unwrap().unwrap().cursor, 7);
}

#[test]
fn pull_applies_remote_changes_without_overwriting_dirty_notes() {
    let lib = library();
    bind(
        &lib,
        &RemoteBatch {
            cursor: 1,
            full: true,
            notes: vec![remote(A, 1, "a1"), remote(B, 1, "b1"), remote(C, 1, "c1")],
            ..RemoteBatch::default()
        },
    );
    let local_b = lib.get_note(&B.parse().unwrap()).unwrap();
    edit(&lib, &local_b, "b local");
    let folder = Folder {
        id: "01arz3ndektsv4rrffq69g5fa5".parse().unwrap(),
        parent_id: None,
        name: "Remote".into(),
        icon: None,
        color: None,
        position: 1.0,
        created_at: Millis::new(1).unwrap(),
        updated_at: Millis::new(1).unwrap(),
        note_count: None,
    };
    lib.sync_apply(&RemoteBatch {
        cursor: 9,
        full: false,
        notes: vec![remote(A, 2, "a2"), remote(B, 2, "b remote")],
        folders: vec![folder],
        deletions: vec![SyncDeletion {
            entity: DeletedEntity::Note,
            id: C.into(),
        }],
        ..RemoteBatch::default()
    })
    .unwrap();
    assert_eq!(lib.get_note(&A.parse().unwrap()).unwrap().content, "a2");
    assert_eq!(
        lib.get_note(&B.parse().unwrap()).unwrap().content,
        "b local"
    );
    assert!(trashed(&lib, C));
    assert_eq!(lib.list_folders(false).unwrap()[0].name, "Remote");
    assert_eq!(item(&lib, "note", A), Some((Some(2), false)));
    assert_eq!(
        item(&lib, "note", B),
        Some((Some(1), true)),
        "push resolves it via 409"
    );
    assert_eq!(lib.sync_binding().unwrap().unwrap().cursor, 9);
    // Applying the same batch again changes nothing.
    let pending = lib.sync_pending().unwrap();
    lib.sync_apply(&RemoteBatch {
        cursor: 9,
        notes: vec![remote(A, 2, "a2")],
        ..RemoteBatch::default()
    })
    .unwrap();
    assert_eq!(lib.sync_pending().unwrap(), pending);
    // A full snapshot without a confirmed note deletes it; unpushed local notes stay.
    create(&lib, C.replace("a3", "a6").as_str(), "new", WriteOrigin::Ui);
    lib.sync_apply(&RemoteBatch {
        cursor: 10,
        full: true,
        notes: vec![remote(B, 2, "b remote")],
        ..RemoteBatch::default()
    })
    .unwrap();
    assert!(trashed(&lib, A));
    assert!(
        lib.get_note(&"01arz3ndektsv4rrffq69g5fa6".parse().unwrap())
            .is_ok()
    );
}

#[test]
fn settle_keeps_rows_edited_during_push_dirty() {
    let lib = library();
    let note = create(&lib, A, "v1", WriteOrigin::Ui);
    let sent = lib.sync_dirty().unwrap().remove(0);
    edit(&lib, &note, "v2");
    lib.sync_settle(sent.entity, &sent.id, Some(1), &sent.seen)
        .unwrap();
    assert_eq!(item(&lib, "note", A), Some((Some(1), true)));
    let next = lib.sync_dirty().unwrap().remove(0);
    assert!(matches!(&next.row, LocalRow::Note(n) if n.content == "v2"));
    assert_eq!(next.remote_rev, Some(1));
}

#[test]
fn conflict_keeps_server_version_and_a_pending_local_copy() {
    let lib = library();
    bind(
        &lib,
        &RemoteBatch {
            cursor: 1,
            full: true,
            notes: vec![remote(A, 1, "base")],
            ..RemoteBatch::default()
        },
    );
    let local = lib.get_note(&A.parse().unwrap()).unwrap();
    edit(&lib, &local, "mine");
    let item_a = lib.sync_dirty().unwrap().remove(0);
    assert!(
        lib.sync_fork_conflict(&remote(A, 2, "theirs"), &item_a.seen)
            .unwrap()
    );
    assert_eq!(lib.get_note(&A.parse().unwrap()).unwrap().content, "theirs");
    assert_eq!(item(&lib, "note", A), Some((Some(2), false)));
    let pending = lib.sync_dirty().unwrap();
    assert_eq!(pending.len(), 1);
    assert!(
        matches!(
            &pending[0].row,
            LocalRow::Note(copy)
                if copy.content == "mine" && copy.summary.title.contains("冲突")
        ),
        "the local version survives as a conflict copy"
    );
    assert_eq!(pending[0].remote_rev, None);
}

#[test]
fn unbind_keeps_local_data_and_marks_everything_pending() {
    let lib = library();
    bind(
        &lib,
        &RemoteBatch {
            cursor: 1,
            full: true,
            notes: vec![remote(A, 1, "a")],
            ..RemoteBatch::default()
        },
    );
    assert_eq!(lib.sync_pending().unwrap(), 0);
    lib.sync_unbind().unwrap();
    assert!(lib.sync_binding().unwrap().is_none());
    assert_eq!(lib.get_note(&A.parse().unwrap()).unwrap().content, "a");
    assert_eq!(item(&lib, "note", A), Some((None, true)));
}
