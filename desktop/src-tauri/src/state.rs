//! Shared application state and startup context.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use aether_providers::Store as ProviderStore;
use note_core::{AppError, Error, ErrorCode, Library, LibraryDeps, RandomIds, SystemClock};

use crate::events;

/// Cancel flags for running Channel-reporting commands, keyed by caller jobId.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Jobs {
    /// Registers `job_id`; a duplicate id is `bad_request` so progress never mixes.
    ///
    /// # Errors
    /// `bad_request` for an empty, oversized or already-running id.
    pub fn start(&self, job_id: &str) -> Result<Arc<AtomicBool>, AppError> {
        if job_id.is_empty() || job_id.len() > 128 {
            return Err(AppError::new(
                ErrorCode::BadRequest,
                "jobId must be 1 to 128 characters",
            ));
        }
        let mut jobs = self.0.lock().map_err(|_| AppError::from(Error::Poisoned))?;
        if jobs.contains_key(job_id) {
            return Err(AppError::new(
                ErrorCode::BadRequest,
                "jobId is already running",
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        jobs.insert(job_id.to_owned(), flag.clone());
        Ok(flag)
    }
    pub fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.0.lock() {
            jobs.remove(job_id);
        }
    }
    /// `true` when a running job took the cancel; repeated cancels stay `true`.
    pub fn cancel(&self, job_id: &str) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).cloned())
            .is_some_and(|flag| {
                flag.store(true, Ordering::Relaxed);
                true
            })
    }
}

#[derive(Clone)]
pub struct AppContext {
    pub data_dir: PathBuf,
    pub library: Arc<Library>,
    pub jobs: Arc<Jobs>,
    pub sync: Arc<note_sync::SyncService>,
    pub logs: aether_observability::LogHandle,
    pub providers: Arc<ProviderStore>,
}

pub(crate) fn open_context(
    data_dir: PathBuf,
    sink: Arc<events::TauriChangeSink>,
    logs: aether_observability::LogHandle,
    providers: Arc<ProviderStore>,
) -> Result<AppContext, Error> {
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "AutoNote starting");
    let library = Library::open_with_deps(
        &autonote_shell::paths::library_db(&data_dir),
        LibraryDeps {
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
            sink: sink.clone(),
        },
    )?;
    let library = Arc::new(library);
    let sync = note_sync::SyncService::new(
        library.clone(),
        Arc::new(autonote_shell::credentials::PlatformSecretStore),
        sink.clone(),
    )
    .map_err(|_| Error::invalid("startup", "Sync service unavailable"))?;
    sink.bind_sync(&sync);
    Ok(AppContext {
        data_dir,
        library,
        jobs: Arc::default(),
        sync,
        logs,
        providers,
    })
}
