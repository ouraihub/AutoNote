use super::*;

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
