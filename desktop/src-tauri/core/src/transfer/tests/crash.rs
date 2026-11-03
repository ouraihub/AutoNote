use super::*;

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
                "transfer::tests::crash::crash_restore_child",
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
                for raw in
                    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                {
                    let (id, hash) = raw?;
                    assert_eq!(
                        export::hash_file(
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
fn pinned_export_is_consistent_while_live_library_changes_and_prunes() {
    let source = tempfile::tempdir().unwrap();
    let lib = library(source.path());
    let bytes = b"attachment bytes";
    let begin = lib
        .files_upload_begin(
            "main",
            "fixture.txt",
            "text/plain",
            bytes.len() as u64,
            None,
        )
        .unwrap();
    lib.files_upload_chunk("main", &begin.upload_id, 0, bytes)
        .unwrap();
    let attachment = lib.files_upload_finish("main", &begin.upload_id).unwrap();
    let original = lib
        .create_note(
            &NewNote {
                id: None,
                title: Some("snapshot".into()),
                content: format!("[asset]({})", attachment.url),
                folder_id: None,
                is_starred: false,
            },
            WriteOrigin::Ui,
        )
        .unwrap()
        .value;
    struct Mutate {
        library: Arc<Library>,
        id: crate::NoteId,
        once: std::sync::atomic::AtomicBool,
    }
    impl ProgressSink for Mutate {
        fn report(&self, event: &ProgressEvent) {
            if event.phase == ProgressPhase::Writing
                && !self.once.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                self.library.trash_note(&self.id, WriteOrigin::Ui).unwrap();
                self.library.purge_note(&self.id, WriteOrigin::Ui).unwrap();
                self.library.files_prune().unwrap();
            }
        }
    }
    let output = source.path().join("snapshot.zip");
    TransferService::new(lib.clone(), "pinned".into())
        .unwrap()
        .export_to(
            AuthorizedOutput::open(&output).unwrap(),
            ExportFormat::Zip,
            &Mutate {
                library: lib.clone(),
                id: original.summary.id.clone(),
                once: std::sync::atomic::AtomicBool::new(false),
            },
            &CancellationToken::default(),
        )
        .unwrap();
    assert!(lib.get_note(&original.summary.id).is_err());
    let target = tempfile::tempdir().unwrap();
    let restored = library(target.path());
    TransferService::new(restored.clone(), "pinned-restore".into())
        .unwrap()
        .import_from(
            AuthorizedInput::open_files(vec![output]).unwrap(),
            ImportConflict::Skip,
            &Sink,
            &CancellationToken::default(),
        )
        .unwrap();
    let note = restored.get_note(&original.summary.id).unwrap();
    assert_eq!(note.summary.title, original.summary.title);
    assert_eq!(note.summary.deleted_at, None);
    restored
        .read(|conn| {
            let id: String = conn.query_row("SELECT id FROM attachments", [], |r| r.get(0))?;
            assert_eq!(
                std::fs::read(target.path().join("files").join(id)).unwrap(),
                bytes
            );
            Ok(())
        })
        .unwrap();
}
