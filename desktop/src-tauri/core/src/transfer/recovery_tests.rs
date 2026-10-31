#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "isolated transfer behavior tests"
)]
use super::*;
use crate::{NewNote, WriteOrigin};
use std::fs::File;
use std::io::Write;
use std::sync::Arc;

struct Sink;
impl ProgressSink for Sink {
    fn report(&self, _: &ProgressEvent) {}
}

fn library(root: &std::path::Path) -> Arc<Library> {
    Arc::new(Library::open(&root.join("library.db")).unwrap())
}

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/transfer")
        .join(name)
}

#[test]
fn crash_restore_child() {
    let Ok(root) = std::env::var("AUTONOTE_TRANSFER_CHILD_ROOT") else {
        return;
    };
    let lib = library(std::path::Path::new(&root));
    TransferService::new(lib, "crash".into())
        .unwrap()
        .import_from(
            AuthorizedInput::open_folder(&fixture("v2")).unwrap(),
            ImportConflict::Skip,
            &Sink,
            &CancellationToken::default(),
        )
        .unwrap();
}

#[test]
fn four_crash_boundaries_recover_complete_old_or_new_state() {
    for point in ["validated", "renamed", "before-commit", "committed"] {
        let root = tempfile::tempdir().unwrap();
        let initial = library(root.path());
        let original = initial
            .create_note(
                &NewNote {
                    id: None,
                    title: Some("original".into()),
                    content: "old".into(),
                    folder_id: None,
                    is_starred: false,
                },
                WriteOrigin::Ui,
            )
            .unwrap()
            .value;
        drop(initial);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "transfer::recovery_tests::crash_restore_child",
                "--nocapture",
            ])
            .env("AUTONOTE_TRANSFER_CHILD_ROOT", root.path())
            .env("AUTONOTE_TRANSFER_CRASH", point)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86));
        let recovered = library(root.path());
        assert_eq!(
            recovered.get_note(&original.summary.id).unwrap().content,
            "old"
        );
        let (notes, attachments): (i64, i64) = recovered
            .read(|conn| {
                Ok((
                    conn.query_row("SELECT count(*) FROM notes", [], |r| r.get(0))?,
                    conn.query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))?,
                ))
            })
            .unwrap();
        assert_eq!(
            (notes, attachments),
            if point == "committed" { (2, 1) } else { (1, 0) }
        );
        recovered
            .read(|conn| {
                let mut stmt = conn.prepare("SELECT id,sha256 FROM attachments")?;
                for raw in stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })? {
                    let (id, hash) = raw?;
                    assert_eq!(
                        super::export::hash_file(
                            File::open(root.path().join("files").join(id)).unwrap(),
                            &CancellationToken::default()
                        )
                        .unwrap(),
                        hash
                    );
                }
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn import_cancel_after_object_publish_rolls_back_all_domain_changes() {
    let root = tempfile::tempdir().unwrap();
    let lib = library(root.path());
    let token = CancellationToken::default();
    struct CancelWriting<'a>(&'a CancellationToken);
    impl ProgressSink for CancelWriting<'_> {
        fn report(&self, event: &ProgressEvent) {
            if event.phase == ProgressPhase::Writing {
                self.0.cancel();
            }
        }
    }
    let result = TransferService::new(lib.clone(), "cancel-published".into())
        .unwrap()
        .import_from(
            AuthorizedInput::open_folder(&fixture("v2")).unwrap(),
            ImportConflict::Skip,
            &CancelWriting(&token),
            &token,
        )
        .unwrap();
    assert!(matches!(result, TransferOutcome::Cancelled));
    assert_eq!(
        lib.read(|conn| {
            Ok((
                conn.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))?,
                conn.query_row("SELECT count(*) FROM attachments", [], |r| {
                    r.get::<_, i64>(0)
                })?,
            ))
        })
        .unwrap(),
        (0, 0)
    );
    assert!(!std::fs::read_dir(root.path().join("files"))
        .unwrap()
        .any(|item| crate::id::is_valid_id(&item.unwrap().file_name().to_string_lossy())));
}
