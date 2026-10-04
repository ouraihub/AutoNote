#![allow(
    clippy::unwrap_used,
    reason = "isolated settings fixtures assert stored DTO"
)]
use crate::write::{ChangeSet, ChangeSink, RandomIds, WriteEvent};
use crate::{AppError, Error, ErrorCode, Library, LibraryDeps, SystemClock, WriteOrigin};
use serde_json::json;
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
#[test]
fn settings_partition_roundtrip_and_invalid_patch() {
    let lib = library();
    assert_eq!(lib.settings_get().unwrap().appearance.language, "zh-CN");
    let saved = lib
        .settings_save(&json!({"appearance":{"language":"en-US"}}), WriteOrigin::Ui)
        .unwrap()
        .value;
    assert_eq!(saved.appearance.language, "en-US");
    assert_eq!(saved.editor.font_size, 15.0);
    assert_eq!(lib.settings_get().unwrap().appearance.language, "en-US");
    assert!(matches!(
        lib.settings_save(&json!({"unknown":{}}), WriteOrigin::Ui),
        Err(Error::InvalidInput { .. })
    ));
    assert!(matches!(
        lib.settings_save(&json!({"editor":{"fontSize":-1}}), WriteOrigin::Ui),
        Err(Error::InvalidInput { .. })
    ));
    assert_eq!(lib.settings_get().unwrap().editor.font_size, 15.0);
}
#[test]
fn settings_corruption_is_not_silently_ignored() {
    let lib = library();
    lib.read(|conn| {
        conn.execute(
            "INSERT INTO prefs(key,value,updated_at) VALUES('editor','{broken',1)",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        AppError::from(lib.settings_get().unwrap_err()).code(),
        ErrorCode::Internal
    );
}
