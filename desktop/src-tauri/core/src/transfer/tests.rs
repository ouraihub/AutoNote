#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "isolated transfer behavior tests"
)]
mod crash;
mod scenarios;
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
