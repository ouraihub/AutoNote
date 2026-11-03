#![allow(
    clippy::unwrap_used,
    reason = "a failed unwrap is a failed SQLite behavior test"
)]

use super::*;
use crate::{Clock, Library, LibraryDeps, Millis};
use std::sync::Arc;
struct FixedClock;
impl Clock for FixedClock {
    fn now(&self) -> Result<Millis, crate::Error> {
        Millis::new(1000)
    }
}
struct Sink;
impl ChangeSink for Sink {
    fn library_changed(&self, _: ChangeSet) {}
    fn write_event(&self, _: WriteEvent) {}
}
fn library() -> Library {
    Library::open_in_memory(
        crate::db::test_files_dir(),
        LibraryDeps {
            clock: Arc::new(FixedClock),
            ids: Arc::new(RandomIds),
            sink: Arc::new(Sink),
        },
    )
    .unwrap()
}
fn folder(lib: &Library, body: serde_json::Value) -> Result<crate::Folder, crate::Error> {
    lib.create_folder(&crate::parse_input(body)?, WriteOrigin::Ui)
        .map(|w| w.value)
}
#[test]
fn organization_names_positions_and_cycles_are_rejected() {
    let lib = library();
    let root = folder(&lib, serde_json::json!({ "name": " Root " })).unwrap();
    assert_eq!(root.name, "Root");
    assert!(matches!(
        folder(&lib, serde_json::json!({ "name": "root" })),
        Err(crate::Error::Duplicate { .. })
    ));
    let again = folder(
        &lib,
        serde_json::json!({ "id": root.id, "name": "ignored" }),
    )
    .unwrap();
    assert_eq!(again, root, "existing id is returned as-is");
    let first = folder(&lib, serde_json::json!({})).unwrap();
    let second = folder(&lib, serde_json::json!({ "name": "  " })).unwrap();
    assert_eq!(
        (first.name.as_str(), second.name.as_str()),
        ("New folder", "New folder 2")
    );
    assert!(
        first.position < second.position,
        "appended after last sibling"
    );
    let front = folder(
        &lib,
        serde_json::json!({ "name": "Front", "beforeId": root.id }),
    )
    .unwrap();
    assert!(front.position < root.position);

    let patch = |id: &crate::FolderId, body: serde_json::Value| {
        lib.patch_folder(id, &crate::parse_input(body).unwrap(), WriteOrigin::Ui)
            .map(|w| w.value)
    };
    let moved = patch(
        &second.id,
        serde_json::json!({ "parentId": null, "beforeId": first.id }),
    )
    .unwrap();
    assert!(moved.position < first.position);
    let order: Vec<_> = lib
        .list_folders(false)
        .unwrap()
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(order, ["Front", "Root", "New folder 2", "New folder"]);
    assert!(
        matches!(
            patch(&root.id, serde_json::json!({ "beforeId": first.id })),
            Err(crate::Error::InvalidInput { .. })
        ),
        "beforeId without parentId"
    );
    assert!(
        matches!(
            patch(&root.id, serde_json::json!({ "parentId": root.id })),
            Err(crate::Error::InvalidInput { .. })
        ),
        "cycle"
    );
    let cleared = patch(
        &root.id,
        serde_json::json!({ "icon": "📁📁📁📁📁", "color": "#dc2626" }),
    )
    .unwrap();
    assert_eq!(
        (cleared.icon.as_deref(), cleared.name.as_str()),
        (Some("📁📁📁📁"), "Root")
    );
    assert_eq!(
        patch(&root.id, serde_json::json!({ "color": null }))
            .unwrap()
            .color,
        None
    );
}
#[test]
fn tag_delete_rewrites_note_and_removes_derived_reference() {
    let lib = library();
    let tag = lib
        .create_tag(
            &crate::parse_input(serde_json::json!({ "name": "gone" })).unwrap(),
            WriteOrigin::Ui,
        )
        .unwrap()
        .value;
    let note = lib
        .create_note(
            &NewNote {
                id: None,
                title: Some("n".into()),
                content: "body #gone".into(),
                folder_id: None,
                is_starred: false,
            },
            WriteOrigin::Ui,
        )
        .unwrap()
        .value;
    let removed = lib.remove_tag(&tag.id, WriteOrigin::Ui).unwrap().value;
    assert_eq!(removed.affected, 1);
    assert_eq!(
        lib.read(|db| Ok(db.query_row(
            "SELECT content FROM notes WHERE id=?1",
            [note.summary.id.as_str()],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        "body "
    );
    assert!(
        lib.list_tags()
            .unwrap()
            .iter()
            .all(|item| item.id != tag.id)
    );
}
