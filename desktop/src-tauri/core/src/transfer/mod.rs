//! Native transfer jobs. Inputs are handles obtained by the native dialog, never IPC paths.
mod export;
mod format;
mod import;
mod obsidian;
mod stage;

use crate::{Error, Library, ProgressEvent, ProgressPhase};
use serde::{Deserialize, Serialize};
pub use stage::{AuthorizedInput, AuthorizedOutput};
use std::sync::{Arc, Mutex};

/// Supported output formats; JSON intentionally contains no binary attachments.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Zip,
    Json,
}
/// ID collision policy applied again under the active library write fence.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportConflict {
    Skip,
    Newer,
    Duplicate,
}
/// Counts of actual committed changes and bounded, safe source warnings.
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub created_notes: u64,
    pub updated_notes: u64,
    pub skipped_notes: u64,
    pub created_folders: u64,
    pub created_attachments: u64,
    pub skipped_attachments: u64,
    pub warnings: Vec<String>,
}
/// Explicit cancellation is not an error or a completed import.
#[derive(Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum TransferOutcome<T> {
    Completed(T),
    Cancelled,
}
/// Internal export counters, never a frontend filesystem path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub format: ExportFormat,
    pub note_count: u64,
    pub attachment_count: u64,
    pub bytes: u64,
}
/// A per-job progress receiver; adapters may throttle non-terminal events.
pub trait ProgressSink: Send + Sync {
    fn report(&self, event: &ProgressEvent);
}
/// Serializes cancellation against irreversible commit/publication.
#[derive(Default)]
pub struct CancellationToken {
    state: Mutex<State>,
}
#[derive(Default)]
enum State {
    #[default]
    Running,
    Cancelled,
    Committing,
    Finished,
}
impl CancellationToken {
    /// Requests cancellation only while the job remains interruptible.
    pub fn cancel(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        match *state {
            State::Running | State::Cancelled => {
                *state = State::Cancelled;
                true
            }
            _ => false,
        }
    }
    /// Checks cancellation between bounded units of blocking work.
    /// # Errors
    /// Returns cancellation or poisoned-state errors.
    pub fn check(&self) -> Result<(), Error> {
        if matches!(*self.state.lock()?, State::Cancelled) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
    pub(crate) fn committing(&self) -> Result<(), Error> {
        let mut state = self.state.lock()?;
        if matches!(*state, State::Cancelled) {
            return Err(Error::Cancelled);
        }
        *state = State::Committing;
        Ok(())
    }
    /// Prevents a completed job ID from accepting another cancel request.
    pub fn finish(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = State::Finished;
        }
    }
}
/// Blocking transfer service sharing the existing domain write pipeline.
pub struct TransferService {
    library: Arc<Library>,
    job_id: String,
}
impl TransferService {
    /// Creates a service for a host-registered job identifier.
    /// # Errors
    /// Rejects unsafe or oversized job IDs.
    pub fn new(library: Arc<Library>, job_id: String) -> Result<Self, Error> {
        if job_id.is_empty()
            || job_id.len() > 128
            || !job_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(Error::invalid("jobId", "invalid transfer job"));
        }
        Ok(Self { library, job_id })
    }
    /// Exports one consistent snapshot to a native-dialog-authorized target.
    /// # Errors
    /// Returns validation, disk or publication errors without truncating the target.
    pub fn export_to(
        &self,
        output: AuthorizedOutput,
        format: ExportFormat,
        progress: &dyn ProgressSink,
        cancel: &CancellationToken,
    ) -> Result<TransferOutcome<ExportSummary>, Error> {
        outcome(export::run(self, output, format, progress, cancel))
    }
    /// Validates all input before atomically merging the disk-backed import plan.
    /// # Errors
    /// Returns validation/storage errors without partially committing the plan.
    pub fn import_from(
        &self,
        input: AuthorizedInput,
        conflict: ImportConflict,
        progress: &dyn ProgressSink,
        cancel: &CancellationToken,
    ) -> Result<TransferOutcome<ImportResult>, Error> {
        outcome(import::run(self, input, conflict, progress, cancel))
    }
    fn progress(&self, sink: &dyn ProgressSink, phase: ProgressPhase, completed: u64) {
        sink.report(&ProgressEvent {
            job_id: self.job_id.clone(),
            phase,
            completed,
            total: None,
            terminal: false,
        });
    }
}
fn outcome<T>(result: Result<T, Error>) -> Result<TransferOutcome<T>, Error> {
    match result {
        Ok(value) => Ok(TransferOutcome::Completed(value)),
        Err(Error::Cancelled) => Ok(TransferOutcome::Cancelled),
        Err(error) => Err(error),
    }
}

/// Recovers interrupted imports before attachment pruning starts.
/// # Errors
/// Returns storage errors without removing any database-referenced object.
pub fn recover_staging(library: &Library) -> Result<(), Error> {
    let root = library
        .files
        .transfer_root()
        .parent()
        .ok_or_else(|| Error::invalid("source", "missing data directory"))?
        .join("staging")
        .join("import");
    if !root.exists() {
        return Ok(());
    }
    stage::reject_reparse(&std::fs::symlink_metadata(&root)?)?;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with("transfer-")
            && entry.file_type()?.is_dir()
            && !entry.file_type()?.is_symlink()
        {
            stage::reject_reparse(&std::fs::symlink_metadata(entry.path())?)?;
            let plan = entry.path().join("plan.sqlite");
            if plan.is_file() {
                stage::reject_reparse(&std::fs::symlink_metadata(&plan)?)?;
                let db = rusqlite::Connection::open(&plan)?;
                let has_journal: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='published')",
                    [],
                    |r| r.get(0),
                )?;
                if has_journal {
                    let job: String =
                        db.query_row("SELECT value FROM metadata WHERE key='job'", [], |r| {
                            r.get(0)
                        })?;
                    library.read(|conn| {
                        let committed: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM app_meta WHERE key=?1 AND value='committed')", [format!("import:{job}")], |r| r.get(0))?;
                        let mut objects = db.prepare("SELECT id,hash FROM published")?;
                        for raw in objects.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
                            let (id, hash) = raw?;
                            if !crate::id::is_valid_id(&id) || !format::hash_valid(&hash) { return Err(format::invalid()) }
                            let referenced: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1) OR EXISTS(SELECT 1 FROM notes WHERE instr(content,?2)>0) OR EXISTS(SELECT 1 FROM note_versions WHERE instr(content,?2)>0)", rusqlite::params![id,format!("/api/files/{id}")], |r| r.get(0))?;
                            let path = library.files.transfer_root().join(&id);
                            if referenced {
                                if committed && export::hash_file(std::fs::File::open(path)?, &CancellationToken::default())? != hash { return Err(format::invalid()) }
                            } else {
                                match std::fs::remove_file(path) {
                                    Ok(()) => (),
                                    Err(error) if error.kind()==std::io::ErrorKind::NotFound => (),
                                    Err(error) => return Err(error.into()),
                                }
                            }
                        }
                        conn.execute("DELETE FROM app_meta WHERE key=?1", [format!("import:{job}")])?;
                        Ok(())
                    })?;
                }
                drop(db);
            }
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}
#[cfg(test)]
#[path = "recovery_tests.rs"]
mod recovery_tests;
mod tests;
