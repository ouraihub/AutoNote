use super::*;

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
