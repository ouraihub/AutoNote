use super::*;

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
