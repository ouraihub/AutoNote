#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "isolated transfer behavior tests"
)]
use super::*;
use crate::{NewNote, WriteOrigin};
use std::fs::File;
use std::io::{Read, Write};
use std::sync::Arc;
struct Sink;
impl ProgressSink for Sink {
    fn report(&self, _: &ProgressEvent) {}
}
fn library(root: &std::path::Path) -> Arc<Library> {
    Arc::new(Library::open(&root.join("library.db")).unwrap())
}
#[test]
fn backup_roundtrip_validation_and_cancellation_are_atomic() {
    let source = tempfile::tempdir().unwrap();
    let source_lib = library(source.path());
    let note = source_lib
        .create_note(
            &NewNote {
                id: None,
                title: Some("Transfer".into()),
                content: "---\ntags: [one]\n---\n# Transfer\nbody".into(),
                folder_id: None,
                is_starred: false,
            },
            WriteOrigin::Ui,
        )
        .unwrap()
        .value;
    let selected = source.path().join("backup.zip");
    let service = TransferService::new(source_lib.clone(), "roundtrip".into()).unwrap();
    assert!(matches!(
        service
            .export_to(
                AuthorizedOutput::open(&selected).unwrap(),
                ExportFormat::Zip,
                &Sink,
                &CancellationToken::default()
            )
            .unwrap(),
        TransferOutcome::Completed(_)
    ));
    let mut archive = zip::ZipArchive::new(File::open(&selected).unwrap()).unwrap();
    let mut manifest = String::new();
    archive
        .by_name("manifest.json")
        .unwrap()
        .read_to_string(&mut manifest)
        .unwrap();
    let hash = crate::markdown::sha256_hex(&manifest);
    let mut complete = String::new();
    archive
        .by_name("COMPLETE")
        .unwrap()
        .read_to_string(&mut complete)
        .unwrap();
    assert_eq!(
        complete,
        format!("autonote-markdown-backup v3\nmanifest-sha256 {hash}\n")
    );
    let target = tempfile::tempdir().unwrap();
    let target_lib = library(target.path());
    let import = TransferService::new(target_lib.clone(), "restore".into()).unwrap();
    assert!(matches!(
        import
            .import_from(
                AuthorizedInput::open_files(vec![selected.clone()]).unwrap(),
                ImportConflict::Skip,
                &Sink,
                &CancellationToken::default()
            )
            .unwrap(),
        TransferOutcome::Completed(ImportResult {
            created_notes: 1,
            ..
        })
    ));
    assert_eq!(
        target_lib.get_note(&note.summary.id).unwrap().content,
        note.content
    );
    let cancel = CancellationToken::default();
    assert!(cancel.cancel());
    assert!(matches!(
        import
            .import_from(
                AuthorizedInput::open_files(vec![selected]).unwrap(),
                ImportConflict::Duplicate,
                &Sink,
                &cancel
            )
            .unwrap(),
        TransferOutcome::Cancelled
    ));
    assert_eq!(
        target_lib
            .get_note(&note.summary.id)
            .unwrap()
            .summary
            .rev
            .get(),
        1
    );
    let broken = source.path().join("broken.zip");
    let mut writer = zip::ZipWriter::new(File::create(&broken).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("manifest.json", options).unwrap();
    writer.write_all(manifest.as_bytes()).unwrap();
    writer.start_file("COMPLETE", options).unwrap();
    writer.write_all(b"corrupt").unwrap();
    writer.finish().unwrap();
    assert!(
        import
            .import_from(
                AuthorizedInput::open_files(vec![broken]).unwrap(),
                ImportConflict::Duplicate,
                &Sink,
                &CancellationToken::default()
            )
            .is_err()
    );
    assert_eq!(
        target_lib.get_note(&note.summary.id).unwrap().content,
        note.content
    );
}
#[test]
fn folder_import_uses_disk_index_not_http_file_ceiling() {
    let vault = tempfile::tempdir().unwrap();
    // 501 files and >80 MiB exercise folder restore beyond both HTTP ceilings.
    let content = "x".repeat(170_000);
    for index in 0..501 {
        std::fs::write(
            vault.path().join(format!("note-{index}.md")),
            format!("# {index}\n{content}"),
        )
        .unwrap();
    }
    let target = tempfile::tempdir().unwrap();
    let lib = library(target.path());
    let service = TransferService::new(lib.clone(), "large-folder".into()).unwrap();
    let result = service
        .import_from(
            AuthorizedInput::open_folder(vault.path()).unwrap(),
            ImportConflict::Skip,
            &Sink,
            &CancellationToken::default(),
        )
        .unwrap();
    assert!(matches!(
        result,
        TransferOutcome::Completed(ImportResult {
            created_notes: 501,
            ..
        })
    ));
    // Imported rows are local edits: every note waits for the first push.
    assert_eq!(lib.sync_pending().unwrap(), 501);
}
#[test]
fn path_and_code_boundaries_do_not_silently_weaken() {
    for path in [
        "../evil",
        "C:/evil",
        "a\\b",
        "a//b",
        "NUL.txt",
        "x:stream",
        "a./b",
        "a /b",
        "/absolute",
    ] {
        assert!(format::safe_path(path).is_err(), "{path}");
    }
    assert!(format::safe_path("notes/safe.md").is_ok());
    let text = "[[target#section|alias]]\n`[[target]]`\n```md\n[[target]]\n```\n![[image.png]]\n";
    let rewritten = obsidian::rewrite(text, |name, asset| {
        Ok(Some(if asset {
            "/api/files/test".into()
        } else {
            format!("resolved:{name}")
        }))
    })
    .unwrap();
    assert!(rewritten.contains("[[resolved:target#section|alias]]"));
    assert!(rewritten.contains("`[[target]]`"));
    assert!(rewritten.contains("```md\n[[target]]\n```"));
    assert!(rewritten.contains("![image.png](/api/files/test)"));
    let token = CancellationToken::default();
    token.committing().unwrap();
    assert!(!token.cancel());
}

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/transfer")
        .join(name)
}

#[test]
fn reference_v2_fixture_and_json_roundtrip_restore_fields() {
    let target = tempfile::tempdir().unwrap();
    let lib = library(target.path());
    let service = TransferService::new(lib.clone(), "v2-fixture".into()).unwrap();
    let outcome = service
        .import_from(
            AuthorizedInput::open_folder(&fixture("v2")).unwrap(),
            ImportConflict::Skip,
            &Sink,
            &CancellationToken::default(),
        )
        .unwrap();
    assert!(matches!(
        outcome,
        TransferOutcome::Completed(ImportResult {
            created_notes: 1,
            created_attachments: 1,
            ..
        })
    ));
    let id = crate::NoteId::new("01arz3ndektsv4rrffq69g5fav".into()).unwrap();
    let note = lib.get_note(&id).unwrap();
    assert_eq!(note.summary.title, "Historical layout");
    assert!(note.content.contains("/api/files/"));
    assert!(note.summary.tags.iter().any(|name| name == "fixture"));
    let output = target.path().join("bundle.json");
    service
        .export_to(
            AuthorizedOutput::open(&output).unwrap(),
            ExportFormat::Json,
            &Sink,
            &CancellationToken::default(),
        )
        .unwrap();
    let bundle: serde_json::Value = serde_json::from_reader(File::open(&output).unwrap()).unwrap();
    assert_eq!(bundle["attachments"], serde_json::json!([]));
    let second = tempfile::tempdir().unwrap();
    let second_lib = library(second.path());
    TransferService::new(second_lib.clone(), "json-restore".into())
        .unwrap()
        .import_from(
            AuthorizedInput::open_files(vec![output]).unwrap(),
            ImportConflict::Skip,
            &Sink,
            &CancellationToken::default(),
        )
        .unwrap();
    assert_eq!(second_lib.get_note(&id).unwrap().content, note.content);
}

#[test]
fn overwrite_cancel_and_publication_failure_keep_existing_target() {
    let root = tempfile::tempdir().unwrap();
    let lib = library(root.path());
    lib.create_note(
        &NewNote {
            id: None,
            title: Some("one".into()),
            content: "body".into(),
            folder_id: None,
            is_starred: false,
        },
        WriteOrigin::Ui,
    )
    .unwrap();
    let target = root.path().join("saved.zip");
    std::fs::write(&target, b"original").unwrap();
    let service = TransferService::new(lib, "replace".into()).unwrap();
    struct CancelWriting<'a>(&'a CancellationToken);
    impl ProgressSink for CancelWriting<'_> {
        fn report(&self, event: &ProgressEvent) {
            if event.phase == ProgressPhase::Writing {
                self.0.cancel();
            }
        }
    }
    let token = CancellationToken::default();
    assert!(matches!(
        service
            .export_to(
                AuthorizedOutput::open(&target).unwrap(),
                ExportFormat::Zip,
                &CancelWriting(&token),
                &token
            )
            .unwrap(),
        TransferOutcome::Cancelled
    ));
    assert_eq!(std::fs::read(&target).unwrap(), b"original");
    service
        .export_to(
            AuthorizedOutput::open(&target).unwrap(),
            ExportFormat::Zip,
            &Sink,
            &CancellationToken::default(),
        )
        .unwrap();
    assert!(zip::ZipArchive::new(File::open(&target).unwrap()).is_ok());
    let blocked = root.path().join("blocked.zip");
    std::fs::create_dir(&blocked).unwrap();
    std::fs::write(blocked.join("sentinel"), b"keep").unwrap();
    assert!(
        service
            .export_to(
                AuthorizedOutput::open(&blocked).unwrap(),
                ExportFormat::Zip,
                &Sink,
                &CancellationToken::default()
            )
            .is_err()
    );
    assert_eq!(std::fs::read(blocked.join("sentinel")).unwrap(), b"keep");
    assert!(!std::fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".partial")
    }));
}

#[test]
fn obsidian_relative_links_ambiguity_and_code_survive_zip_and_folder() {
    let mut semantics = Vec::new();
    for zipped in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let lib = library(root.path());
        let source = if zipped {
            let zip_path = root.path().join("vault.zip");
            let mut zip = zip::ZipWriter::new(File::create(&zip_path).unwrap());
            for name in ["entry.md", "one/twin.md", "two/twin.md"] {
                zip.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(&std::fs::read(fixture("obsidian").join(name)).unwrap())
                    .unwrap();
            }
            zip.finish().unwrap();
            AuthorizedInput::open_files(vec![zip_path]).unwrap()
        } else {
            AuthorizedInput::open_folder(&fixture("obsidian")).unwrap()
        };
        let result = TransferService::new(lib.clone(), "vault".into())
            .unwrap()
            .import_from(
                source,
                ImportConflict::Skip,
                &Sink,
                &CancellationToken::default(),
            )
            .unwrap();
        let TransferOutcome::Completed(result) = result else {
            panic!("unexpected cancellation")
        };
        assert_eq!(result.created_notes, 3);
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("Ambiguous"))
        );
        let (entry_id, twin_id): (String, String) = lib
            .read(|conn| {
                Ok((
                    conn.query_row("SELECT id FROM notes WHERE title='entry'", [], |r| r.get(0))?,
                    conn.query_row("SELECT id FROM notes WHERE title='First twin'", [], |r| {
                        r.get(0)
                    })?,
                ))
            })
            .unwrap();
        let body = lib
            .get_note(&crate::NoteId::new(entry_id).unwrap())
            .unwrap()
            .content;
        assert!(body.contains(&format!("[specific](/notes/{twin_id}#Heading)")));
        assert!(body.contains("[[twin]]"));
        assert!(body.contains("`[[one/twin]]`"));
        assert!(body.contains("```md\n[[one/twin]]\n```"));
        semantics.push(body.replace(&twin_id, "MATCHED"));
    }
    assert_eq!(semantics[0], semantics[1]);
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
                "transfer::tests::crash_restore_child",
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

#[test]
fn skip_newer_duplicate_and_invalid_payload_keep_atomic_semantics() {
    let source = tempfile::tempdir().unwrap();
    let lib = library(source.path());
    let original = lib
        .create_note(
            &NewNote {
                id: None,
                title: Some("source".into()),
                content: "body".into(),
                folder_id: None,
                is_starred: false,
            },
            WriteOrigin::Ui,
        )
        .unwrap()
        .value;
    let output = source.path().join("bundle.json");
    TransferService::new(lib, "bundle".into())
        .unwrap()
        .export_to(
            AuthorizedOutput::open(&output).unwrap(),
            ExportFormat::Json,
            &Sink,
            &CancellationToken::default(),
        )
        .unwrap();
    let target = tempfile::tempdir().unwrap();
    let lib = library(target.path());
    let service = TransferService::new(lib.clone(), "conflicts".into()).unwrap();
    let restore = |policy| {
        service.import_from(
            AuthorizedInput::open_files(vec![output.clone()]).unwrap(),
            policy,
            &Sink,
            &CancellationToken::default(),
        )
    };
    restore(ImportConflict::Skip).unwrap();
    assert!(matches!(
        restore(ImportConflict::Skip).unwrap(),
        TransferOutcome::Completed(ImportResult {
            skipped_notes: 1,
            ..
        })
    ));
    assert!(matches!(
        restore(ImportConflict::Newer).unwrap(),
        TransferOutcome::Completed(ImportResult {
            skipped_notes: 1,
            ..
        })
    ));
    let mut bundle: serde_json::Value =
        serde_json::from_reader(File::open(&output).unwrap()).unwrap();
    bundle["notes"][0]["updatedAt"] = serde_json::json!(crate::types::MAX_SAFE_INTEGER - 10);
    bundle["notes"][0]["content"] = serde_json::json!("updated");
    std::fs::write(&output, serde_json::to_vec(&bundle).unwrap()).unwrap();
    assert!(matches!(
        restore(ImportConflict::Newer).unwrap(),
        TransferOutcome::Completed(ImportResult {
            updated_notes: 1,
            ..
        })
    ));
    assert_eq!(
        lib.get_note(&original.summary.id).unwrap().content,
        "updated"
    );
    assert_eq!(lib.list_versions(&original.summary.id).unwrap().len(), 1);
    assert!(matches!(
        restore(ImportConflict::Duplicate).unwrap(),
        TransferOutcome::Completed(ImportResult {
            created_notes: 1,
            ..
        })
    ));
    bundle["notes"][0]["content"] = serde_json::json!("x".repeat(format::CONTENT_MAX + 1));
    std::fs::write(&output, serde_json::to_vec(&bundle).unwrap()).unwrap();
    assert!(restore(ImportConflict::Newer).is_err());
    assert_eq!(
        lib.get_note(&original.summary.id).unwrap().content,
        "updated"
    );
}

#[test]
fn hostile_archives_reject_without_changing_existing_library() {
    let root = tempfile::tempdir().unwrap();
    let lib = library(root.path());
    let original = lib
        .create_note(
            &NewNote {
                id: None,
                title: Some("existing".into()),
                content: "old".into(),
                folder_id: None,
                is_starred: false,
            },
            WriteOrigin::Ui,
        )
        .unwrap()
        .value;
    let service = TransferService::new(lib.clone(), "hostile".into()).unwrap();
    for (index, paths) in [
        ["../escape.md", "valid.md"],
        ["Note.md", "note.md"],
        ["COMPLETE", "loose.md"],
    ]
    .iter()
    .enumerate()
    {
        let path = root.path().join(format!("bad-{index}.zip"));
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for name in paths {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"invalid").unwrap();
        }
        zip.finish().unwrap();
        assert!(
            service
                .import_from(
                    AuthorizedInput::open_files(vec![path]).unwrap(),
                    ImportConflict::Duplicate,
                    &Sink,
                    &CancellationToken::default()
                )
                .is_err()
        );
        assert_eq!(lib.get_note(&original.summary.id).unwrap().content, "old");
        assert_eq!(
            lib.read(|conn| Ok(
                conn.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))?
            ))
            .unwrap(),
            1
        );
    }
    let linked = root.path().join("linked.md");
    let source = root.path().join("source.md");
    std::fs::write(&source, b"body").unwrap();
    std::fs::hard_link(&source, &linked).unwrap();
    assert!(AuthorizedInput::open_files(vec![linked]).is_err());
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
        lib.read(|conn| Ok((
            conn.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))?,
            conn.query_row("SELECT count(*) FROM attachments", [], |r| r
                .get::<_, i64>(0))?
        )))
        .unwrap(),
        (0, 0)
    );
    assert!(
        !std::fs::read_dir(root.path().join("files"))
            .unwrap()
            .any(|item| crate::id::is_valid_id(&item.unwrap().file_name().to_string_lossy()))
    );
}
