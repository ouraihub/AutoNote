//! Local library file and its versioned migrations.
//!
//! Migrations are append-only: a released entry is never edited, a schema
//! change is a new entry. Opening a file written by a newer build is refused
//! instead of guessed at, because an older binary cannot know what the extra
//! columns mean.

#![allow(
    clippy::missing_errors_doc,
    reason = "public core API docs are finalized with the IPC surface"
)]
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

use crate::error::Error;
use crate::files::FileStore;
use crate::types::Millis;
use crate::write::{
    ChangeSet, ChangeSink, IdSource, RandomIds, WriteOrigin, WriteTx, Written,
};

/// A millisecond clock injected at the library boundary.
/// The result can fail when the supplied time exceeds the safe wire range.
pub trait Clock: Send + Sync {
    fn now(&self) -> Result<Millis, Error>;
}

/// Production wall clock.
pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> Result<Millis, Error> {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| {
                d.as_millis().min(crate::types::MAX_SAFE_INTEGER as u128) as i64
            });
        Millis::new(millis)
    }
}

/// Injected dependencies for the note library.
pub struct LibraryDeps {
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdSource>,
    pub sink: Arc<dyn ChangeSink>,
}

struct NoopSink;
impl ChangeSink for NoopSink {
    fn library_changed(&self, _: ChangeSet) {}
    fn write_event(&self, _: crate::write::WriteEvent) {}
}
mod migrations;
#[cfg(test)]
mod tests;
#[allow(dead_code, reason = "query projections are consumed by D1-6")]
pub(crate) mod rows;

use migrations::MIGRATIONS;

/// A self-locking SQLite library; callers never receive a connection.
pub struct Library {
    pub(crate) conn: Mutex<Connection>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn IdSource>,
    pub(crate) sink: Arc<dyn ChangeSink>,
    pub(crate) files: FileStore,
    writes_stopped: AtomicBool,
}

impl Library {
    pub(crate) fn with_deps(conn: Connection, deps: LibraryDeps, files_dir: &Path) -> Self {
        Self {
            conn: Mutex::new(conn),
            clock: deps.clock,
            ids: deps.ids,
            sink: deps.sink,
            files: FileStore::new(files_dir.to_path_buf()),
            writes_stopped: AtomicBool::new(false),
        }
    }
    fn default_deps() -> LibraryDeps {
        LibraryDeps {
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
            sink: Arc::new(NoopSink),
        }
    }
    #[allow(dead_code, reason = "used by D1-6 query commands")]
    pub(crate) fn read<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let conn = self.conn.lock()?;
        f(&conn)
    }
    pub(crate) fn write<T>(
        &self,
        origin: WriteOrigin,
        f: impl FnOnce(&mut WriteTx<'_>) -> Result<T, Error>,
    ) -> Result<Written<T>, Error> {
        let (value, changes) = {
            let mut conn = self.conn.lock()?;
            if self.writes_stopped.load(Ordering::Acquire) {
                return Err(Error::Cancelled);
            }
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut work = WriteTx {
                tx,
                now: self.clock.now()?,
                ids: self.ids.clone(),
                changes: ChangeSet::default(),
            };
            work.changes.origin = Some(origin);
            let value = f(&mut work)?;
            let changes = std::mem::take(&mut work.changes);
            // The one place local edits become pending sync work; sync's own writes never do.
            if origin != WriteOrigin::Sync {
                crate::sync::mark_dirty(&work.tx, &changes.touched)?;
            }
            work.tx.commit()?;
            (value, changes)
        };
        if !changes.notes.is_empty()
            || !changes.deletions.is_empty()
            || !changes.touched.is_empty()
            || changes.settings_changed
            || changes.import_changed
        {
            self.sink.library_changed(changes.clone());
        }
        Ok(Written { value, changes })
    }

    /// Stops new domain commits, after waiting for the current durable commit.
    /// Reads remain available so shutdown can persist window state and diagnostics.
    /// # Errors
    /// Returns an error if the connection lock is poisoned.
    pub fn stop_writes(&self) -> Result<(), Error> {
        let _connection = self.conn.lock()?;
        self.writes_stopped.store(true, Ordering::Release);
        Ok(())
    }
}

impl Library {
    /// Opens with default system dependencies.
    ///
    /// # Errors
    /// Returns SQLite, migration, or filesystem errors.
    pub fn open(path: &Path) -> Result<Self, Error> {
        Self::open_with_deps(path, Self::default_deps())
    }
    /// Opens a library with injected clock, ID, and change-sink dependencies.
    ///
    /// # Errors
    /// Returns SQLite, migration, or filesystem errors.
    pub fn open_with_deps(path: &Path, deps: LibraryDeps) -> Result<Self, Error> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let files_dir = path
            .parent()
            .ok_or_else(|| Error::invalid("path", "invalid library path"))?
            .join("files");
        let library = Self::with_deps(conn, deps, &files_dir);
        library.migrate()?;
        crate::transfer::recover_staging(&library)?;
        library.files_recover()?;
        library.prune_changes()?;
        Ok(library)
    }

    /// Opens an isolated in-memory SQLite library with injected dependencies.
    pub fn open_in_memory(files_dir: &Path, deps: LibraryDeps) -> Result<Self, Error> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let library = Self::with_deps(conn, deps, files_dir);
        library.migrate()?;
        crate::transfer::recover_staging(&library)?;
        library.files_recover()?;
        Ok(library)
    }

    /// Stable local library identity (`app_meta.library_id`), created on first call.
    ///
    /// # Errors
    /// Returns SQLite errors.
    pub fn library_id(&self) -> Result<String, Error> {
        let conn = self.conn.lock()?;
        let found: Option<String> = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key='library_id'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = found {
            return Ok(id);
        }
        let id = crate::write::new_id(
            self.ids.as_ref(),
            self.clock.now()?,
            &conn.unchecked_transaction()?,
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO app_meta(key,value) VALUES('library_id',?1)",
            [&id],
        )?;
        Ok(conn.query_row(
            "SELECT value FROM app_meta WHERE key='library_id'",
            [],
            |r| r.get(0),
        )?)
    }
    /// Highest applied migration version.
    pub fn schema_version(&self) -> Result<i64, Error> {
        let conn = self.conn.lock()?;
        let version = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<i64>>(0)
        })?;
        Ok(version.unwrap_or(0))
    }

    // Startup-only retention, not an extra write in every note transaction.
    fn prune_changes(&self) -> Result<(), Error> {
        let conn = self.conn.lock()?;
        conn.execute(
            "DELETE FROM changes WHERE seq < (
                 SELECT MIN(seq) FROM (
                   SELECT seq FROM changes ORDER BY seq DESC LIMIT ?1
                 )
               )",
            [5000],
        )?;
        Ok(())
    }

    fn migrate(&self) -> Result<(), Error> {
        let mut conn = self.conn.lock()?;
        migrate(&mut conn, MIGRATIONS)
    }
}

fn migrate(conn: &mut Connection, migrations: &[migrations::Migration]) -> Result<(), Error> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );",
    )?;
    let current = tx
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<i64>>(0)
        })?
        .unwrap_or(0);
    let latest = migrations.last().map_or(0, |migration| migration.version);
    if current > latest {
        return Err(Error::SchemaTooNew {
            found: current,
            supported: latest,
        });
    }
    for migration in migrations.iter().filter(|m| m.version > current) {
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, unixepoch('subsec') * 1000)",
            [migration.version],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// One private attachment root per test process; never the crate source tree.
#[cfg(test)]
#[allow(
    clippy::expect_used,
    reason = "tests cannot run without a temp directory"
)]
pub(crate) fn test_files_dir() -> &'static Path {
    static DIR: std::sync::LazyLock<tempfile::TempDir> =
        std::sync::LazyLock::new(|| tempfile::tempdir().expect("temp attachment root"));
    DIR.path()
}
