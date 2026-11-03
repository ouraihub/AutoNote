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
#[path = "derived_link_tests.rs"]
mod derived_link_tests;
#[path = "derived_tests.rs"]
mod derived_tests;
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;
#[path = "note_write_tests.rs"]
mod note_write_tests;
