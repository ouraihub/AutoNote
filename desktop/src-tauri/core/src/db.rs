//! Local library file and its versioned migrations.
//!
//! Migrations are append-only: a released entry is never edited, a schema
//! change is a new entry. Opening a file written by a newer build is refused
//! instead of guessed at, because an older binary cannot know what the extra
//! columns mean.

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppError;

struct Migration {
    version: i64,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: "CREATE TABLE app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );",
}];

pub struct Library {
    conn: Connection,
}

impl Library {
    /// Opens (creating if needed) the library at `path` and applies pending migrations.
    ///
    /// # Errors
    ///
    /// `DB_ERROR` when SQLite fails, `SCHEMA_TOO_NEW` when the file was written by
    /// a newer AutoNote build.
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let mut library = Self { conn };
        library.migrate()?;
        Ok(library)
    }

    /// Highest applied migration version.
    ///
    /// # Errors
    ///
    /// `DB_ERROR` when the migrations table cannot be read.
    pub fn schema_version(&self) -> Result<i64, AppError> {
        let version =
            self.conn
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, Option<i64>>(0)
                })?;
        Ok(version.unwrap_or(0))
    }

    fn migrate(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
               version INTEGER PRIMARY KEY,
               applied_at INTEGER NOT NULL
             );",
        )?;
        let current = self.schema_version()?;
        let latest = MIGRATIONS.last().map_or(0, |migration| migration.version);
        if current > latest {
            return Err(AppError::new(
                "SCHEMA_TOO_NEW",
                format!("library schema v{current} is newer than this build (v{latest})"),
            ));
        }
        let tx = self.conn.transaction()?;
        for migration in MIGRATIONS.iter().filter(|m| m.version > current) {
            tx.execute_batch(migration.sql)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, unixepoch('subsec') * 1000)",
                [migration.version],
            )?;
            tracing::info!(version = migration.version, "applied migration");
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
mod tests {
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
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(second.schema_version().unwrap(), version);
        assert_eq!(rows, i64::try_from(MIGRATIONS.len()).unwrap());
    }

    #[test]
    fn file_from_newer_build_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.db");
        let library = Library::open(&path).unwrap();
        library
            .conn
            .execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (9999, 0)",
                [],
            )
            .unwrap();
        drop(library);

        let error = Library::open(&path).err().unwrap();
        assert_eq!(error.code, "SCHEMA_TOO_NEW");
    }
}
