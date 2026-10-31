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
            Ok(db.query_row("SELECT id FROM note_versions WHERE note_id=?1", [ID], |r| {
                r.get(0)
            })?)
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
            |r| r.get::<_, i64>(0),
        )?))
        .expect("fts"),
        0
    );
    let live = lib.restore_note(&id, WriteOrigin::Ui).expect("restore").value;
    assert_eq!(live.summary.rev.get(), 5);
    assert!(matches!(
        lib.restore_note(&id, WriteOrigin::Ui),
        Err(crate::Error::InvalidInput { .. })
    ));
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM notes_fts WHERE note_id=?1",
            [ID],
            |r| r.get::<_, i64>(0),
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
            |r| r.get::<_, i64>(0),
        )?))
        .expect("delete cursor"),
        cursor.get()
    );
    lib.create_note(&input("again"), WriteOrigin::Ui)
        .expect("recreate");
    lib.trash_note(&id, WriteOrigin::Ui).expect("trash recreated");
    assert_eq!(lib.empty_trash(WriteOrigin::Ui).expect("empty trash").value, 1);
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM notes WHERE id=?1",
            [ID],
            |r| r.get::<_, i64>(0),
        )?))
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
            |r| r.get::<_, i64>(0),
        )?))
        .expect("history"),
        50
    );
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT COUNT(*) FROM note_versions WHERE note_id=?1 AND content='start'",
            [ID],
            |r| r.get::<_, i64>(0),
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
            |r| r.get::<_, i64>(0),
        )?))
        .expect("snapshot"),
        1
    );
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT target_note_id FROM links WHERE source_note_id=?1",
            [source_id],
            |r| r.get::<_, String>(0),
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
        lib.read(|db| Ok(db.query_row("SELECT COUNT(*) FROM notes_fts", [], |r| {
            r.get::<_, i64>(0)
        })?))
        .expect("fts rows"),
        2
    );
}
