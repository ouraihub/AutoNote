use super::*;

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
