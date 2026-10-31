#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
use super::*;

#[test]
fn reopening_does_not_reapply_migrations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    let first = Library::open(&path).unwrap();
    let version = first.schema_version().unwrap();
    drop(first);

    let second = Library::open(&path).unwrap();
    let rows: i64 = second
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(second.schema_version().unwrap(), version);
    assert_eq!(rows, i64::try_from(MIGRATIONS.len()).unwrap());
}

#[test]
fn startup_prunes_changes_to_latest_five_thousand() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    let library = Library::open(&path).unwrap();
    {
        let conn = library.conn.lock().unwrap();
        let mut insert = conn
            .prepare(
                "INSERT INTO changes (entity, entity_id, op, at) "
                    .to_owned()
                    + "VALUES ('note', 'id', 'upsert', 1)",
            )
            .unwrap();
        for _ in 0..5002 {
            insert.execute([]).unwrap();
        }
    }
    drop(library);
    let library = Library::open(&path).unwrap();
    let conn = library.conn.lock().unwrap();
    let (count, oldest): (i64, i64) = conn
        .query_row("SELECT COUNT(*), MIN(seq) FROM changes", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!((count, oldest), (5000, 3));
}

#[test]
fn legacy_v1_upgrades_without_losing_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    let mut conn = Connection::open(&path).unwrap();
    migrate(&mut conn, &MIGRATIONS[..1]).unwrap();
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)",
        ["existing", "preserved"],
    )
    .unwrap();
    drop(conn);

    let library = Library::open(&path).unwrap();
    let conn = library.conn.lock().unwrap();
    let value: String = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            ["existing"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(value, "preserved");
}

#[test]
fn sync_v7_moves_binding_and_marks_unconfirmed_rows_pending() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    let mut conn = Connection::open(&path).unwrap();
    migrate(&mut conn, &MIGRATIONS[..6]).unwrap();
    let (synced, local, missing) = (
        "01arz3ndektsv4rrffq69g5fa1",
        "01arz3ndektsv4rrffq69g5fa2",
        "01arz3ndektsv4rrffq69g5fa3",
    );
    conn.execute_batch(&format!(
        "INSERT INTO sync_state(binding_id,binding_epoch,site_origin,account_hint,remote_user_id,cookie_ciphertext,cookie_domain,cookie_path,cookie_name,cursor,status,updated_at)\
         VALUES('b',1,'https://example.test','me','u1',x'0102','example.test','/','session',13,'paused',5);\
         INSERT INTO notes(id,title,content,rev,created_at,updated_at) VALUES('{synced}','a','',4,1,1),('{local}','b','',1,1,1);\
         INSERT INTO sync_map(binding_id,binding_epoch,entity,local_id,remote_id,local_rev,remote_rev,state)\
         VALUES('b',1,'note','{synced}','{synced}',0,1,'synced'),('b',1,'note','{missing}','{missing}',0,9,'synced');"
    ))
    .unwrap();
    drop(conn);

    let library = Library::open(&path).unwrap();
    let state = library.sync_binding().unwrap().unwrap();
    assert_eq!(state.binding.remote_user_id, "u1");
    assert_eq!(state.cookie.ciphertext, vec![1, 2]);
    assert_eq!(state.cursor, 0);
    let conn = library.conn.lock().unwrap();
    let item = |id: &str| -> (Option<i64>, bool) {
        conn.query_row(
            "SELECT remote_rev,dirty FROM sync_item WHERE entity='note' AND id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    };
    assert_eq!(item(synced), (Some(1), false));
    assert_eq!(item(local), (None, true));
    let old: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN (\
             'sync_state','sync_map','sync_outbox','sync_attachment_map',\
             'sync_snapshot','sync_conflict')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old, 0);
}

#[test]
fn sync_v7_on_unbound_library_marks_everything_pending() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    let mut conn = Connection::open(&path).unwrap();
    migrate(&mut conn, &MIGRATIONS[..6]).unwrap();
    conn.execute_batch(
        "INSERT INTO notes(id,title,content,created_at,updated_at) VALUES('01arz3ndektsv4rrffq69g5fa1','a','',1,1);\
         INSERT INTO folders(id,name,created_at,updated_at) VALUES('01arz3ndektsv4rrffq69g5fa2','f',1,1);",
    )
    .unwrap();
    drop(conn);
    let library = Library::open(&path).unwrap();
    assert!(library.sync_binding().unwrap().is_none());
    assert_eq!(library.sync_pending().unwrap(), 2);
}

#[test]
fn row_decoding_reads_real_schema_values() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn, MIGRATIONS).unwrap();
    let id = "01arz3ndektsv4rrffq69g5fav";
    let folder = "01arz3ndektsv4rrffq69g5faw";
    let tag = "01arz3ndektsv4rrffq69g5fax";
    conn.execute(
        "INSERT INTO folders (id, name, position, created_at, updated_at) \
         VALUES (?1, 'Inbox', 2.5, 1000, 1001)",
        [folder],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tags (id, name, created_at) VALUES (?1, 'alpha', 1002)",
        [tag],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO notes (id, folder_id, title, content, excerpt, rev, \
         word_count, char_count, is_starred, position, created_at, updated_at) \
         VALUES (?1, ?2, '标题', 'hello world', 'hello', 3, 2, 11, 1, 2.5, 1000, 1003)",
        [id, folder],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
        [id, tag],
    )
    .unwrap();
    let note = conn
        .query_row(
            "SELECT n.id, n.folder_id, n.title, n.excerpt, n.rev, \
             n.word_count, n.char_count, n.is_pinned, n.is_starred, \
             n.is_archived, n.position, n.created_at, n.updated_at, \
             n.deleted_at, (SELECT GROUP_CONCAT(t.name, char(1)) FROM \
             note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id), \
             n.content FROM notes n WHERE n.id = ?1",
            [id],
            rows::note,
        )
        .unwrap();
    assert_eq!(note.summary.id.as_str(), id);
    assert_eq!(note.summary.folder_id.unwrap().as_str(), folder);
    assert_eq!(note.summary.rev.get(), 3);
    assert!(note.summary.is_starred);
    assert_eq!(note.summary.tags, ["alpha"]);
    assert_eq!(note.content, "hello world");
    let folder = conn
        .query_row(
            "SELECT id, parent_id, name, icon, color, position, created_at, \
             updated_at, (SELECT COUNT(*) FROM notes WHERE folder_id = folders.id \
             AND deleted_at IS NULL) FROM folders WHERE id = ?1",
            [folder],
            rows::folder,
        )
        .unwrap();
    assert_eq!(folder.name, "Inbox");
    assert_eq!(folder.note_count, Some(1));
    let tag = conn
        .query_row(
            "SELECT id, name, color, created_at, \
             (SELECT COUNT(*) FROM note_tags WHERE tag_id = tags.id) \
             FROM tags WHERE id = ?1",
            [tag],
            rows::tag,
        )
        .unwrap();
    assert_eq!(tag.name, "alpha");
    assert_eq!(tag.count, 1);
    let version_id = "01arz3ndektsv4rrffq69g5fay";
    conn.execute(
        "INSERT INTO note_versions (id, note_id, title, content, size, created_at) \
         VALUES (?1, ?2, '旧标题', 'old', 3, 1001)",
        [version_id, id],
    )
    .unwrap();
    let version = conn
        .query_row(
            "SELECT id, note_id, title, size, created_at, content \
             FROM note_versions WHERE id = ?1",
            [version_id],
            rows::version,
        )
        .unwrap();
    assert_eq!(version.meta.note_id.as_str(), id);
    assert_eq!(version.meta.size, 3);
    assert_eq!(version.content, "old");
    let attachment_id = "01arz3ndektsv4rrffq69g5faz";
    conn.execute(
        "INSERT INTO attachments (id, note_id, filename, mime, size, sha256, created_at) \
         VALUES (?1, ?2, 'image.png', 'image/png', 42, 'digest', 1004)",
        [attachment_id, id],
    )
    .unwrap();
    let attachment = conn
        .query_row(
            "SELECT id, note_id, filename, mime, size, width, height, created_at \
             FROM attachments WHERE id = ?1",
            [attachment_id],
            rows::attachment,
        )
        .unwrap();
    assert_eq!(attachment.url, format!("/api/files/{attachment_id}"));
    assert_eq!(attachment.note_id.unwrap().as_str(), id);
    assert_eq!(attachment.size, 42);
}

#[test]
fn failed_migration_rolls_back_entire_upgrade() {
    let mut conn = Connection::open_in_memory().unwrap();
    let broken = [
        migrations::Migration {
            version: 1,
            sql: MIGRATIONS[0].sql,
        },
        migrations::Migration {
            version: 2,
            sql: "CREATE TABLE partial (id INTEGER); CREATE TABLE partial (id INTEGER);",
        },
    ];
    assert!(matches!(migrate(&mut conn, &broken), Err(Error::Sqlite(_))));
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN \
             ('app_meta', 'partial', 'schema_migrations')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
    migrate(&mut conn, MIGRATIONS).unwrap();
    conn.execute(
        "INSERT INTO app_meta(key,value) VALUES('recovered','preserved')",
        [],
    )
    .unwrap();
    let recovered: String = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key='recovered'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recovered, "preserved");
}

#[test]
fn failed_v2_leaves_legacy_v1_unchanged() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn, &MIGRATIONS[..1]).unwrap();
    let broken = [
        migrations::Migration {
            version: 1,
            sql: MIGRATIONS[0].sql,
        },
        migrations::Migration {
            version: 2,
            sql: "CREATE TABLE partial (id INTEGER); CREATE TABLE partial (id INTEGER);",
        },
    ];
    assert!(matches!(migrate(&mut conn, &broken), Err(Error::Sqlite(_))));
    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    let partial: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='partial'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, 1);
    assert_eq!(partial, 0);
}

#[test]
fn file_from_newer_build_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    let library = Library::open(&path).unwrap();
    library
        .conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (9999, 0)",
            [],
        )
        .unwrap();
    drop(library);

    let error = Library::open(&path).err().unwrap();
    assert!(matches!(error, Error::SchemaTooNew { found: 9999, .. }));
}
