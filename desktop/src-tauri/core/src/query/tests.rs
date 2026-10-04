#![allow(
    clippy::unwrap_used,
    reason = "isolated query fixture asserts concrete results"
)]
use super::*;
use crate::write::{ChangeSet, ChangeSink, RandomIds, WriteEvent};
use crate::{
    AppError, Error, ErrorCode, Library, LibraryDeps, NewNote, NoteId, NotePatch, SystemClock,
    WriteOrigin,
};
use std::sync::Arc;
struct Sink;
impl ChangeSink for Sink {
    fn library_changed(&self, _: ChangeSet) {}
    fn write_event(&self, _: WriteEvent) {}
}
fn library() -> Library {
    Library::open_in_memory(
        crate::db::test_files_dir(),
        LibraryDeps {
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
            sink: Arc::new(Sink),
        },
    )
    .unwrap()
}
fn create(lib: &Library, title: &str, content: &str) -> NoteId {
    lib.create_note(
        &NewNote {
            id: None,
            title: Some(title.into()),
            content: content.into(),
            folder_id: None,
            is_starred: false,
        },
        WriteOrigin::Ui,
    )
    .unwrap()
    .value
    .summary
    .id
}
#[test]
fn pagination_filters_and_cursor_boundary() {
    let lib = library();
    let a = create(&lib, "alpha", "#tag [[beta]]");
    let b = create(&lib, "beta", "#tag");
    let c = create(&lib, "gamma", "plain");
    let pinned = lib
        .patch_note(
            &c,
            &NotePatch {
                rev: crate::Rev::new(1).unwrap(),
                title: None,
                content: None,
                folder_id: None,
                is_pinned: Some(true),
                is_starred: None,
                is_archived: None,
                quiet: false,
                preserve_version: false,
            },
            WriteOrigin::Ui,
        )
        .unwrap();
    assert!(pinned.value.summary.is_pinned);
    let mut query = ListNotesQuery {
        limit: Some(1),
        ..Default::default()
    };
    let first = lib.list_notes(&query).unwrap();
    assert_eq!(first.total, 3);
    assert_eq!(first.notes[0].id, c);
    query.cursor = first.next_cursor;
    let second = lib.list_notes(&query).unwrap();
    assert_ne!(second.notes[0].id, c);
    query.limit = Some(201);
    assert!(matches!(
        lib.list_notes(&query),
        Err(Error::InvalidInput { field: "limit", .. })
    ));
    query.limit = Some(-1);
    assert!(lib.list_notes(&query).is_err());
    query.limit = Some(1);
    query.cursor = Some("n1.{\"evil\":true}".into());
    assert!(lib.list_notes(&query).is_err());
    query.cursor = None;
    query.view = NoteView::Tag;
    query.tag = Some("TAG".into());
    assert_eq!(lib.list_notes(&query).unwrap().total, 2);
    query.view = NoteView::All;
    assert!(lib.list_notes(&query).is_err());
    let backlink = lib.backlinks(&b).unwrap();
    assert_eq!(backlink.len(), 1);
    assert_eq!(backlink[0].id, a);
    lib.trash_note(&a, WriteOrigin::Ui).unwrap();
    assert!(lib.backlinks(&b).unwrap().is_empty());
    let trash = ListNotesQuery {
        view: NoteView::Trash,
        ..Default::default()
    };
    assert_eq!(lib.list_notes(&trash).unwrap().notes[0].id, a);
    assert_eq!(
        AppError::from(lib.get_note(&a).unwrap_err()).code(),
        ErrorCode::NotFound
    );
}

#[test]
fn rejects_unknown_query_fields_and_invalid_ranges() {
    assert!(crate::parse_input::<ListNotesQuery>(serde_json::json!({"unexpected":1})).is_err());
    assert!(crate::parse_input::<ListNotesQuery>(serde_json::json!({"view":"unknown"})).is_err());
    assert!(crate::parse_input::<GraphQuery>(serde_json::json!({"center":"../../etc"})).is_err());
    assert!(
        crate::parse_input::<GraphQuery>(serde_json::json!({"includeUnresolved":"yes"})).is_err()
    );
    assert!(crate::parse_input::<SearchQuery>(serde_json::json!({"limit":-1,"extra":1})).is_err());
    let lib = library();
    assert!(
        lib.search_graph(&GraphQuery {
            limit: Some(601),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        lib.search_graph(&GraphQuery {
            q: Some("x".repeat(201)),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        lib.search_query(&SearchQuery {
            q: "a".repeat(513),
            limit: None
        })
        .is_err()
    );
}
#[test]
fn search_filters_fts_and_graph_edges() {
    let lib = library();
    let target = create(&lib, "Target", "hello searchable");
    let source = create(&lib, "Source", "[[Target]] #metal searchable");
    let _missing = create(&lib, "orphan", "[[Unknown]]");
    let result = lib
        .search_query(&SearchQuery {
            q: "searchable tag:metal".into(),
            limit: Some(20),
        })
        .unwrap();
    assert_eq!(result.mode, SearchMode::Fts);
    assert_eq!(result.results.len(), 1);
    assert_eq!(result.results[0].note.id, source);
    let graph = lib
        .search_graph(&GraphQuery {
            mode: Some("local".into()),
            center: Some(target.clone()),
            limit: Some(50),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.edges.len(), 1);
    assert_eq!(graph.edges[0].source, source.as_str());
    assert!(
        lib.search_graph(&GraphQuery {
            mode: Some("local".into()),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        lib.search_graph(&GraphQuery {
            depth: Some(4),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        lib.search_query(&SearchQuery {
            q: "x".into(),
            limit: Some(0)
        })
        .is_err()
    );
    assert!(matches!(
        lib.search_reindex(&mut |done, _| if done == 2 {
            Err(crate::Error::Cancelled)
        } else {
            Ok(())
        }),
        Err(crate::Error::Cancelled)
    ));
    let fts: i64 = lib
        .read(|db| Ok(db.query_row("SELECT COUNT(*) FROM notes_fts", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(fts, 3, "cancelled rebuild rolled back");
    let mut seen = Vec::new();
    assert_eq!(
        lib.search_reindex(&mut |done, total| {
            seen.push((done, total));
            Ok(())
        })
        .unwrap(),
        3
    );
    assert_eq!(seen, [(1, 3), (2, 3), (3, 3)]);
    assert_eq!(
        lib.search_query(&SearchQuery {
            q: "searchable tag:metal".into(),
            limit: None
        })
        .unwrap()
        .results
        .len(),
        1
    );
}
#[test]
fn graph_truncation_and_deleted_edges() {
    let lib = library();
    let center = create(&lib, "Hub", "a");
    for i in 0..51 {
        create(&lib, &format!("Leaf{i}"), "[[Hub]]");
    }
    let graph = lib
        .search_graph(&GraphQuery {
            mode: Some("local".into()),
            center: Some(center.clone()),
            limit: Some(50),
            ..Default::default()
        })
        .unwrap();
    assert!(graph.meta.truncated);
    assert_eq!(graph.meta.total_nodes, 52);
    assert_eq!(graph.nodes.len(), 50);
    lib.trash_note(&center, WriteOrigin::Ui).unwrap();
    assert!(
        lib.search_graph(&GraphQuery {
            mode: Some("local".into()),
            center: Some(center),
            limit: Some(50),
            ..Default::default()
        })
        .is_err()
    );
}

#[test]
fn fts_and_like_use_identical_unicode_and_filter_predicates() {
    let lib = library();
    let matching = create(&lib, "中文海", "内容含中文海 #甲");
    let _other = create(&lib, "中文海", "内容含中文海 #乙");
    let _literal = create(&lib, "100%_\\", "100%_\\ #甲");
    let fts = lib
        .search_query(&SearchQuery {
            q: "中文海 tag:甲".into(),
            limit: Some(50),
        })
        .unwrap();
    assert_eq!(fts.mode, SearchMode::Fts);
    assert_eq!(fts.results.len(), 1);
    assert_eq!(fts.results[0].note.id, matching);
    lib.read(|conn| {
        conn.execute("DROP TABLE notes_fts", [])?;
        Ok(())
    })
    .unwrap();
    let like = lib
        .search_query(&SearchQuery {
            q: "中文海 tag:甲".into(),
            limit: Some(50),
        })
        .unwrap();
    assert_eq!(like.mode, SearchMode::Like);
    assert_eq!(like.results.len(), fts.results.len());
    assert_eq!(like.results[0].note.id, matching);
    assert_eq!(
        lib.search_query(&SearchQuery {
            q: "100%_\\".into(),
            limit: None
        })
        .unwrap()
        .results
        .len(),
        1
    );
}

#[test]
fn graph_limits_large_orphan_set_and_unresolved_nodes() {
    let lib = library();
    for i in 0..55 {
        create(&lib, &format!("T{i}"), &format!("[[Missing{i}]]"));
    }
    let graph = lib
        .search_graph(&GraphQuery {
            include_unresolved: Some(true),
            limit: Some(50),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(graph.meta.total_nodes, 56);
    assert!(graph.meta.truncated);
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.edges.len(), 1);
}

#[test]
fn change_feed_is_incremental_tombstones_purges_and_resets_stale_cursors() {
    let lib = library();
    let kept = create(&lib, "Kept", "a");
    let start = lib.notes_snapshot().unwrap();
    assert!(start.full && start.settings_changed && start.notes.len() == 1);
    assert!(
        lib.library_changes(crate::Cursor::new(0).unwrap())
            .unwrap()
            .full,
        "since=0 is full"
    );

    let gone = create(&lib, "Gone", "b");
    let step = lib.library_changes(start.cursor).unwrap();
    assert!(!step.full && !step.settings_changed);
    assert_eq!(step.notes.len(), 1);

    lib.trash_note(&gone, WriteOrigin::Ui).unwrap();
    lib.purge_note(&gone, WriteOrigin::Ui).unwrap();
    lib.settings_save(
        &serde_json::json!({ "editor": { "fontSize": 15 } }),
        WriteOrigin::Ui,
    )
    .unwrap();
    let after = lib.library_changes(step.cursor).unwrap();
    assert!(
        after.notes.iter().all(|n| n.id != gone),
        "purged note is not upserted"
    );
    assert_eq!(after.deletions.len(), 1);
    assert_eq!(after.deletions[0].id, gone.to_string());
    assert!(after.settings_changed);
    assert!(
        lib.library_changes(after.cursor).unwrap().notes.is_empty(),
        "no change, no rows"
    );

    let ahead = crate::Cursor::new(after.cursor.get() + 10).unwrap();
    assert!(
        lib.library_changes(ahead).unwrap().full,
        "cursor from another library resets"
    );
    let keep_from = after.cursor.get() - 1;
    lib.read(|db| Ok(db.execute("DELETE FROM changes WHERE seq <= ?1", [keep_from])?))
        .unwrap();
    let pruned = lib.library_changes(start.cursor).unwrap();
    assert!(
        pruned.full,
        "a gap in the retained feed must not look incremental"
    );
    assert_eq!(
        pruned
            .notes
            .iter()
            .map(|n| n.id.clone())
            .collect::<Vec<_>>(),
        vec![kept]
    );
}
