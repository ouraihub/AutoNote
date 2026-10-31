#![allow(
    clippy::unwrap_used,
    reason = "a failed unwrap is a failed attachment test"
)]
use std::fs::{self, File};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::*;
use crate::write::{ChangeSet, ChangeSink, RandomIds, WriteEvent};
use crate::{LibraryDeps, SystemClock};

struct Sink;
impl ChangeSink for Sink {
    fn library_changed(&self, _: ChangeSet) {}
    fn write_event(&self, _: WriteEvent) {}
}

fn library(root: &Path) -> Library {
    Library::open_in_memory(
        root,
        LibraryDeps {
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
            sink: Arc::new(Sink),
        },
    )
    .unwrap()
}

fn upload(lib: &Library, bytes: &[u8]) -> Attachment {
    let begin = lib
        .files_upload_begin("main", "a.txt", "text/plain", bytes.len() as u64, None)
        .unwrap();
    lib.files_upload_chunk("main", &begin.upload_id, 0, bytes)
        .unwrap();
    lib.files_upload_finish("main", &begin.upload_id).unwrap()
}

#[test]
fn sync_download_publishes_file_and_map_atomically() -> Result<(), Error> {
    let dir = tempfile::tempdir().unwrap();
    let lib = library(dir.path());
    let remote = "01arz3ndektsv4rrffq69g5fax";
    let hash = format!("{:x}", Sha256::digest(b"data"));
    let stage = || {
        let begin = lib
            .files_upload_begin("sync", "a.txt", "text/plain", 4, None)
            .unwrap();
        lib.files_upload_chunk("sync", &begin.upload_id, 0, b"data")
            .unwrap();
        begin
    };
    let count = |sql: &str| -> Result<i64, Error> {
        Ok(lib.conn.lock()?.query_row(sql, [], |r| r.get(0))?)
    };
    let begin = stage();
    assert!(lib
        .files_sync_finish("sync", &begin.upload_id, remote, "wrong")
        .is_err());
    lib.conn.lock()?.execute_batch(
        "CREATE TRIGGER reject_map BEFORE INSERT ON sync_attachment \
         BEGIN SELECT RAISE(ABORT,'test'); END;",
    )?;
    let begin = stage();
    assert!(lib
        .files_sync_finish("sync", &begin.upload_id, remote, &hash)
        .is_err());
    assert_eq!(count("SELECT COUNT(*) FROM attachments")?, 0);
    lib.conn.lock()?.execute_batch("DROP TRIGGER reject_map;")?;
    let begin = stage();
    let saved = lib.files_sync_finish("sync", &begin.upload_id, remote, &hash)?;
    assert_eq!(
        lib.sync_attachment_local(remote)?.as_deref(),
        Some(saved.id.as_str())
    );
    assert_eq!(
        lib.sync_attachment_remote(saved.id.as_str())?.as_deref(),
        Some(remote)
    );
    Ok(())
}

fn age(path: &Path) {
    let old = std::time::SystemTime::now() - RETENTION - Duration::from_secs(60);
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(old)
        .unwrap();
}

#[test]
fn active_uploads_count_toward_quota_and_session_cap() {
    let dir = tempfile::tempdir().unwrap();
    let lib = library(dir.path());
    let mut open = Vec::new();
    for _ in 0..MAX_SESSIONS {
        open.push(lib.files_upload_begin("main", "a", "", 1, None).unwrap());
    }
    assert!(lib.files_upload_begin("main", "a", "", 1, None).is_err());
    for begin in &open {
        lib.files_upload_cancel("main", &begin.upload_id).unwrap();
    }
    let used = (QUOTA_BYTES - MAX_BYTES) as i64;
    lib.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO attachments(id,filename,mime,size,sha256,created_at) \
             VALUES('01arz3ndektsv4rrffq69g5fax','f','',?1,'',0)",
            [used],
        )
        .unwrap();
    let first = lib
        .files_upload_begin("main", "a", "", MAX_BYTES, None)
        .unwrap();
    assert!(matches!(
        lib.files_upload_begin("main", "a", "", 1, None),
        Err(Error::TooLarge { .. })
    ));
    lib.files_upload_cancel("main", &first.upload_id).unwrap();
    assert!(lib.files_upload_begin("main", "a", "", 1, None).is_ok());
}

#[test]
fn recovery_keeps_objects_still_linked_from_notes_or_versions() {
    let dir = tempfile::tempdir().unwrap();
    let lib = library(dir.path());
    let linked: AttachmentId = "01arz3ndektsv4rrffq69g5fav".parse().unwrap();
    let orphan: AttachmentId = "01arz3ndektsv4rrffq69g5faw".parse().unwrap();
    for id in [&linked, &orphan] {
        fs::write(dir.path().join(id.as_str()), b"x").unwrap();
        age(&dir.path().join(id.as_str()));
    }
    lib.create_note(
        &crate::NewNote {
            id: None,
            title: None,
            content: format!("![x](/api/files/{linked})"),
            folder_id: None,
            is_starred: false,
        },
        crate::WriteOrigin::Ui,
    )
    .unwrap();
    lib.files_recover().unwrap();
    assert!(dir.path().join(linked.as_str()).exists());
    assert!(!dir.path().join(orphan.as_str()).exists());
}

#[test]
fn upload_enforces_size_offset_window_and_single_use() {
    let dir = tempfile::tempdir().unwrap();
    let lib = library(dir.path());
    assert!(matches!(
        lib.files_upload_begin("main", "big", "", MAX_BYTES + 1, None),
        Err(Error::TooLarge { .. })
    ));
    let begin = lib
        .files_upload_begin("main", "a.txt", "text/plain", 4, None)
        .unwrap();
    let id = &begin.upload_id;
    assert!(lib.files_upload_chunk("other", id, 0, b"ab").is_err());
    assert!(lib.files_upload_chunk("main", id, 1, b"ab").is_err());
    assert!(matches!(
        lib.files_upload_chunk("main", id, 0, b"abcde"),
        Err(Error::TooLarge { .. })
    ));
    assert_eq!(lib.files_upload_chunk("main", id, 0, b"ab").unwrap(), 2);
    assert!(lib.files_upload_finish("main", id).is_err());
    assert_eq!(lib.files_upload_chunk("main", id, 2, b"cd").unwrap(), 4);
    assert!(lib.files_upload_finish("other", id).is_err());
    let saved = lib.files_upload_finish("main", id).unwrap();
    assert!(lib.files_upload_finish("main", id).is_err());
    let (mut file, meta) = lib.files_open(&saved.id).unwrap();
    let mut body = String::new();
    std::io::Read::read_to_string(&mut file, &mut body).unwrap();
    assert_eq!((body.as_str(), meta.size), ("abcd", 4));
}

#[test]
fn traversal_and_illegal_ids_never_reach_the_filesystem() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("secret"), b"x").unwrap();
    for raw in [
        "../secret",
        "..\\secret",
        "secret",
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "",
    ] {
        assert!(AttachmentId::new(raw.to_owned()).is_err());
    }
    let lib = library(&dir.path().join("files"));
    let unregistered: AttachmentId = "01arz3ndektsv4rrffq69g5fav".parse().unwrap();
    fs::write(
        dir.path().join("files").join(unregistered.as_str()),
        b"x",
    )
    .unwrap();
    assert!(matches!(
        lib.files_open(&unregistered),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn stage_files_are_never_served() {
    let dir = tempfile::tempdir().unwrap();
    let lib = library(dir.path());
    let begin = lib
        .files_upload_begin("main", "a.txt", "text/plain", 2, None)
        .unwrap();
    lib.files_upload_chunk("main", &begin.upload_id, 0, b"ab")
        .unwrap();
    let staged = fs::read_dir(dir.path().join(".stage"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let name = staged.file_name().into_string().unwrap();
    let id = name.split('.').next().unwrap().parse::<AttachmentId>().unwrap();
    assert!(matches!(lib.files_open(&id), Err(Error::NotFound { .. })));
}

#[test]
fn db_failure_after_publish_keeps_the_object_for_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let lib = library(dir.path());
    let note = lib
        .create_note(
            &crate::NewNote {
                id: None,
                title: None,
                content: String::new(),
                folder_id: None,
                is_starred: false,
            },
            crate::WriteOrigin::Ui,
        )
        .unwrap()
        .value
        .summary
        .id;
    let begin = lib
        .files_upload_begin("main", "a.txt", "text/plain", 2, Some(note.clone()))
        .unwrap();
    lib.files_upload_chunk("main", &begin.upload_id, 0, b"ab")
        .unwrap();
    lib.trash_note(&note, crate::WriteOrigin::Ui).unwrap();
    assert!(lib.files_upload_finish("main", &begin.upload_id).is_err());
    let published: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.unwrap().file_name().into_string().ok())
        .filter(|n| crate::id::is_valid_id(n))
        .collect();
    assert_eq!(published.len(), 1);
    lib.files_recover().unwrap();
    assert!(dir.path().join(&published[0]).exists());
}

#[test]
fn prune_spares_references_young_orphans_and_foreign_files() {
    let dir = tempfile::tempdir().unwrap();
    let lib = library(dir.path());
    let kept = upload(&lib, b"kept");
    lib.create_note(
        &crate::NewNote {
            id: None,
            title: None,
            content: format!("![x]({})", kept.url),
            folder_id: None,
            is_starred: false,
        },
        crate::WriteOrigin::Ui,
    )
    .unwrap();
    let dropped = upload(&lib, b"gone");
    let young: AttachmentId = "01arz3ndektsv4rrffq69g5fav".parse().unwrap();
    let old: AttachmentId = "01arz3ndektsv4rrffq69g5faw".parse().unwrap();
    fs::write(dir.path().join(young.as_str()), b"y").unwrap();
    fs::write(dir.path().join(old.as_str()), b"o").unwrap();
    fs::write(dir.path().join("notes.md"), b"user data").unwrap();
    age(&dir.path().join(old.as_str()));
    age(&dir.path().join("notes.md"));
    age(&dir.path().join(dropped.id.as_str()));

    let page = lib.files_list(None).unwrap();
    assert_eq!((page.files.len(), page.next_cursor), (2, None));
    assert!(matches!(lib.files_list(Some("x.y")), Err(Error::InvalidInput { .. })));
    assert_eq!(
        lib.files_prune().unwrap(),
        crate::dto::PruneResult {
            removed: 1,
            freed_bytes: 4,
        }
    );
    assert!(lib.files_open(&kept.id).is_ok());
    assert!(matches!(
        lib.files_open(&dropped.id),
        Err(Error::NotFound { .. })
    ));
    assert!(!dir.path().join(dropped.id.as_str()).exists());
    assert!(dir.path().join(young.as_str()).exists());
    assert!(!dir.path().join(old.as_str()).exists());
    assert!(dir.path().join("notes.md").exists());
}

#[test]
fn missing_object_does_not_block_opening_the_library() {
    let dir = tempfile::tempdir().unwrap();
    let lib = library(dir.path());
    let saved = upload(&lib, b"ab");
    fs::remove_file(dir.path().join(saved.id.as_str())).unwrap();
    lib.files_recover().unwrap();
    assert!(lib.files_open(&saved.id).is_err());
}
