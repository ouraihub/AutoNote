#![allow(
    clippy::expect_used,
    reason = "a failed expectation is a failed SQLite behavior test"
)]

use super::*;
use crate::{Clock, Library, LibraryDeps, Millis, Rev};
use std::sync::{Arc, mpsc};

struct FixedClock;
impl Clock for FixedClock {
    fn now(&self) -> Result<Millis, Error> {
        Millis::new(1000)
    }
}
struct RecordingSink(mpsc::Sender<String>);
impl ChangeSink for RecordingSink {
    fn library_changed(&self, change: ChangeSet) {
        let _ = self.0.send(format!(
            "library:{}:{}",
            change.notes.len(),
            change.deletions.len()
        ));
    }
    fn write_event(&self, event: WriteEvent) {
        let _ = self.0.send(format!("{event:?}"));
    }
}
fn library() -> (Library, mpsc::Receiver<String>) {
    let (sender, receiver) = mpsc::channel();
    let lib = Library::open_in_memory(
        crate::db::test_files_dir(),
        LibraryDeps {
            clock: Arc::new(FixedClock),
            ids: Arc::new(RandomIds),
            sink: Arc::new(RecordingSink(sender)),
        },
    )
    .expect("in-memory SQLite library");
    (lib, receiver)
}
fn input(content: &str) -> NewNote {
    NewNote {
        id: Some(ID.parse().expect("id")),
        title: Some("Alpha".into()),
        content: content.into(),
        folder_id: None,
        is_starred: false,
    }
}
fn patch(rev: i64, content: &str) -> NotePatch {
    NotePatch {
        rev: Rev::new(rev).expect("rev"),
        title: None,
        content: Some(content.into()),
        folder_id: None,
        is_pinned: None,
        is_starred: None,
        is_archived: None,
        quiet: false,
        preserve_version: false,
    }
}
const ID: &str = "01arz3ndektsv4rrffq69g5fav";

#[test]
fn stale_rev_is_conflict_and_noop_does_not_write() {
    let (lib, rx) = library();
    let created = lib
        .create_note(&input("hello #tag [[Alpha]]"), WriteOrigin::Ui)
        .expect("created")
        .value;
    let same = lib
        .patch_note(
            &created.summary.id,
            &patch(1, "hello #tag [[Alpha]]"),
            WriteOrigin::Ui,
        )
        .expect("no-op");
    assert_eq!(same.value.summary.rev.get(), 1);
    assert!(same.changes.notes.is_empty());
    let changed = lib
        .patch_note(&created.summary.id, &patch(1, "new #tag"), WriteOrigin::Ui)
        .expect("changed");
    assert_eq!(changed.value.summary.rev.get(), 2);
    assert!(matches!(
        lib.patch_note(&created.summary.id, &patch(1, "stale"), WriteOrigin::Ui),
        Err(Error::Conflict { .. })
    ));
    assert_eq!(
        lib.read(
            |db| Ok(db.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get::<_, i64>(0))?)
        )
        .expect("changes"),
        2
    );
    assert_eq!(
        rx.try_iter().filter(|v| v.starts_with("library:")).count(),
        2
    );
}

#[test]
fn write_events_commit_before_settled_and_retain_failed_body() {
    let (lib, rx) = library();
    let id = lib
        .create_note(&input("first"), WriteOrigin::Ui)
        .expect("created")
        .value
        .summary
        .id;
    assert_eq!(rx.try_recv().expect("create event"), "library:1:0");
    lib.patch_note_with_write_id(&id, &patch(1, "second"), "write-1", WriteOrigin::Ui)
        .expect("saved");
    let events: Vec<_> = rx.try_iter().collect();
    assert!(events[0].contains("Pending"));
    assert_eq!(events[1], "library:1:0");
    assert!(events[2].contains("Settled"));
    assert!(matches!(
        lib.patch_note_with_write_id(&id, &patch(1, "stale"), "write-2", WriteOrigin::Ui),
        Err(Error::Conflict { .. })
    ));
    let events: Vec<_> = rx.try_iter().collect();
    assert_eq!(events.len(), 2);
    assert!(events[0].contains("Pending"));
    assert!(events[1].contains("Failed") && events[1].contains("retained: true"));
}

#[test]
fn simultaneous_writes_cannot_both_commit_the_same_revision() {
    let (lib, _events) = library();
    let id = lib
        .create_note(&input("start"), WriteOrigin::Ui)
        .expect("created")
        .value
        .summary
        .id;
    let shared = Arc::new(lib);
    let threads: Vec<_> = (0..2)
        .map(|n| {
            let lib = shared.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                lib.patch_note(&id, &patch(1, &format!("edit {n}")), WriteOrigin::Ui)
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|t| t.join().expect("thread did not panic"))
        .collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r.as_ref(), Err(Error::Conflict { .. })))
            .count(),
        1
    );
    assert_eq!(
        shared
            .read(|db| Ok(
                db.query_row("SELECT rev FROM notes WHERE id=?1", [ID], |r| r
                    .get::<_, i64>(0))?
            ))
            .expect("rev"),
        2
    );
    assert_eq!(
        shared
            .read(
                |db| Ok(db.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get::<_, i64>(0))?)
            )
            .expect("changes"),
        2
    );
}

#[test]
fn derived_versions_and_error_rollback_share_one_transaction() {
    let (lib, _rx) = library();
    let note = lib
        .create_note(&input("hello #one [[Alpha]]"), WriteOrigin::Ui)
        .expect("created")
        .value;
    let id = note.summary.id;
    let changed = lib
        .patch_note(&id, &patch(1, "bye #two [[Alpha]]"), WriteOrigin::Ui)
        .expect("patched")
        .value;
    assert_eq!(changed.summary.tags, ["two"]);
    lib.read(|db| {
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE note_id=?1",
                [ID],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM links WHERE source_note_id=?1 AND target_note_id=?1",
                [ID],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM note_versions WHERE note_id=?1",
                [ID],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
        let (body, hash): (String, String) = db.query_row(
            "SELECT content,content_hash FROM notes WHERE id=?1",
            [ID],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        assert_eq!(hash, crate::markdown::sha256_hex(&body));
        Ok(())
    })
    .expect("derived reads");
    assert_eq!(
        lib.read(|db| Ok(
            db.query_row("SELECT COUNT(*) FROM tags WHERE name='one'", [], |r| r
                .get::<_, i64>(0))?
        ))
        .expect("orphan tag"),
        0
    );
    assert_eq!(
        lib.read(|db| Ok(
            db.query_row("SELECT COUNT(*) FROM tags WHERE name='two'", [], |r| r
                .get::<_, i64>(0))?
        ))
        .expect("new tag"),
        1
    );
    let bad = NotePatch {
        rev: Rev::new(2).expect("rev"),
        folder_id: Some(Some("01arz3ndektsv4rrffq69g5faw".parse().expect("id"))),
        ..patch(2, "must rollback #oops")
    };
    assert!(lib.patch_note(&id, &bad, WriteOrigin::Ui).is_err());
    assert_eq!(
        lib.read(|db| Ok(db
            .query_row("SELECT content FROM notes WHERE id=?1", [ID], |r| r
                .get::<_, String>(0))?))
            .expect("content"),
        "bye #two [[Alpha]]"
    );
    assert_eq!(
        lib.read(
            |db| Ok(db.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get::<_, i64>(0))?)
        )
        .expect("changes"),
        2
    );
}

#[test]
fn derived_failure_rolls_back_insert_and_emits_no_commit_event() {
    struct DuplicateIds;
    impl IdSource for DuplicateIds {
        fn new_id(&self, _: Millis, _: &[u8; 16]) -> String {
            ID.into()
        }
    }
    let (sender, rx) = mpsc::channel();
    let lib = Library::open_in_memory(
        crate::db::test_files_dir(),
        LibraryDeps {
            clock: Arc::new(FixedClock),
            ids: Arc::new(DuplicateIds),
            sink: Arc::new(RecordingSink(sender)),
        },
    )
    .expect("database");
    assert!(
        lib.create_note(&input("#one #two"), WriteOrigin::Ui)
            .is_err()
    );
    assert_eq!(
        lib.read(|db| Ok(db.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))?))
            .expect("notes"),
        0
    );
    assert_eq!(
        lib.read(
            |db| Ok(db.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get::<_, i64>(0))?)
        )
        .expect("changes"),
        0
    );
    assert_eq!(rx.try_iter().count(), 0);
}

#[test]
fn trash_restore_purge_and_version() {
    let (lib, _rx) = library();
    let id = lib
        .create_note(&input("first #a"), WriteOrigin::Ui)
        .expect("created")
        .value
        .summary
        .id;
    let newer = lib
        .patch_note(&id, &patch(1, "second #b"), WriteOrigin::Ui)
        .expect("patched")
        .value;
    let vid: String = lib
        .read(|db| {
            Ok(
                db.query_row("SELECT id FROM note_versions WHERE note_id=?1", [ID], |r| {
                    r.get(0)
                })?,
            )
        })
        .expect("version");
    let restored = lib
        .restore_version(
            &id,
            &vid.parse().expect("version id"),
            newer.summary.rev,
            WriteOrigin::Ui,
        )
        .expect("restored version")
        .value;
    assert_eq!(restored.content, "first #a");
    assert_eq!(restored.summary.rev.get(), 3);
    let trash = lib.trash_note(&id, WriteOrigin::Ui).expect("trash").value;
    assert_eq!(trash.summary.rev.get(), 4);
    assert!(matches!(
        lib.trash_note(&id, WriteOrigin::Ui),
        Err(crate::Error::NotFound { .. })
    ));
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM notes_fts WHERE note_id=?1",
            [ID],
            |r| r.get::<_, i64>(0)
        )?))
        .expect("fts"),
        0
    );
    let live = lib
        .restore_note(&id, WriteOrigin::Ui)
        .expect("restore")
        .value;
    assert_eq!(live.summary.rev.get(), 5);
    assert!(matches!(
        lib.restore_note(&id, WriteOrigin::Ui),
        Err(crate::Error::InvalidInput { .. })
    ));
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM notes_fts WHERE note_id=?1",
            [ID],
            |r| r.get::<_, i64>(0)
        )?))
        .expect("fts"),
        1
    );
    assert!(lib.purge_note(&id, WriteOrigin::Ui).is_err());
    lib.trash_note(&id, WriteOrigin::Ui).expect("trash again");
    let cursor = lib.purge_note(&id, WriteOrigin::Ui).expect("purge").value;
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT MAX(seq) FROM changes WHERE op='delete'",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .expect("delete cursor"),
        cursor.get()
    );
    lib.create_note(&input("again"), WriteOrigin::Ui)
        .expect("recreate");
    lib.trash_note(&id, WriteOrigin::Ui)
        .expect("trash recreated");
    assert_eq!(
        lib.empty_trash(WriteOrigin::Ui).expect("empty trash").value,
        1
    );
    assert_eq!(
        lib.read(|db| Ok(db
            .query_row("SELECT COUNT(*) FROM notes WHERE id=?1", [ID], |r| r
                .get::<_, i64>(0))?))
            .expect("gone"),
        0
    );
}

#[test]
fn version_retention_keeps_only_latest_fifty() {
    let (lib, _rx) = library();
    let id = lib
        .create_note(&input("start"), WriteOrigin::Ui)
        .expect("create")
        .value
        .summary
        .id;
    for rev in 1_i64..=52 {
        let mut update = patch(rev, &format!("body {rev}"));
        update.preserve_version = true;
        lib.patch_note(&id, &update, WriteOrigin::Ui)
            .expect("preserve previous version");
    }
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM note_versions WHERE note_id=?1",
            [ID],
            |r| r.get::<_, i64>(0)
        )?))
        .expect("history"),
        50
    );
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM note_versions WHERE note_id=?1 AND content='start'",
            [ID],
            |r| r.get::<_, i64>(0)
        )?))
        .expect("oldest removed"),
        0
    );
}

#[test]
fn title_rename_rewrites_inbound_note_with_snapshot() {
    let (lib, _rx) = library();
    let target = lib
        .create_note(&input("target"), WriteOrigin::Ui)
        .expect("target")
        .value;
    let source_id = "01arz3ndektsv4rrffq69g5faw";
    let source = lib
        .create_note(
            &NewNote {
                id: Some(source_id.parse().expect("source ID")),
                title: Some("Source".into()),
                content: "visit [[Alpha#part|caption]]".into(),
                folder_id: None,
                is_starred: false,
            },
            WriteOrigin::Ui,
        )
        .expect("source")
        .value;
    let rename = NotePatch {
        rev: Rev::FIRST,
        title: Some("Beta".into()),
        content: None,
        folder_id: None,
        is_pinned: None,
        is_starred: None,
        is_archived: None,
        quiet: false,
        preserve_version: false,
    };
    let result = lib
        .patch_note(&target.summary.id, &rename, WriteOrigin::Ui)
        .expect("rename");
    assert_eq!(result.changes.notes.len(), 2);
    let updated = lib
        .read(|db| {
            Ok(db.query_row(
                "SELECT content,rev FROM notes WHERE id=?1",
                [source.summary.id.as_str()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )?)
        })
        .expect("rewritten");
    assert_eq!(updated, ("visit [[Beta#part|caption]]".to_owned(), 2));
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM note_versions WHERE note_id=?1",
            [source_id],
            |r| r.get::<_, i64>(0)
        )?))
        .expect("snapshot"),
        1
    );
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT target_note_id FROM links WHERE source_note_id=?1",
            [source_id],
            |r| r.get::<_, String>(0)
        )?))
        .expect("target"),
        target.summary.id.as_str()
    );
}

#[test]
fn duplicate_produces_independent_derived_rows() {
    let (lib, _rx) = library();
    let old = lib
        .create_note(&input("#one [[Alpha]]"), WriteOrigin::Ui)
        .expect("original")
        .value;
    let copy = lib
        .duplicate_note(&old.summary.id, None, WriteOrigin::Ui)
        .expect("copy")
        .value;
    assert_ne!(old.summary.id, copy.summary.id);
    assert!(copy.summary.title.ends_with(" copy"));
    let again = lib
        .duplicate_note(&old.summary.id, Some(&copy.summary.id), WriteOrigin::Ui)
        .expect("idempotent copy")
        .value;
    assert_eq!(again.summary.id, copy.summary.id);
    assert_eq!(copy.summary.tags, ["one"]);
    assert_eq!(copy.content, old.content);
    assert_eq!(
        lib.read(|db| Ok(
            db.query_row("SELECT COUNT(*) FROM notes_fts", [], |r| r.get::<_, i64>(0))?
        ))
        .expect("fts rows"),
        2
    );
}
