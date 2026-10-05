//! Native dialogs, window-bound jobs and per-call progress. No frontend paths.
use crate::AppContext;
use note_core::transfer::{
    AuthorizedInput, AuthorizedOutput, CancellationToken, ExportFormat, ImportConflict,
    ImportResult, ProgressSink, TransferOutcome, TransferService,
};
use note_core::{AppError, Error, ErrorCode, ProgressEvent, ProgressPhase};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, ipc::Channel};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Default)]
pub struct TransferJobs {
    inner: Arc<(Mutex<Registry>, Condvar)>,
}
#[derive(Default)]
struct Registry {
    jobs: HashMap<String, Job>,
    closing: bool,
}
struct Job {
    owner: String,
    token: Arc<CancellationToken>,
    active: bool,
    completed: bool,
    touched: Instant,
}
impl TransferJobs {
    fn register(&self, owner: &str, id: &str) -> Result<Arc<CancellationToken>, Error> {
        validate_id(id)?;
        let mut registry = self.inner.0.lock()?;
        registry
            .jobs
            .retain(|_, job| job.active || job.touched.elapsed() < Duration::from_secs(300));
        if registry.closing {
            return Err(Error::invalid("jobId", "application is closing"));
        }
        if let Some(job) = registry.jobs.get_mut(id) {
            if job.owner != owner || job.active || job.completed {
                return Err(Error::invalid("jobId", "duplicate job"));
            }
            job.active = true;
            return Ok(job.token.clone());
        }
        if registry.jobs.len() >= 32 {
            return Err(Error::invalid("jobId", "too many transfer jobs"));
        }
        let token = Arc::new(CancellationToken::default());
        registry.jobs.insert(
            id.to_owned(),
            Job {
                owner: owner.to_owned(),
                token: token.clone(),
                active: true,
                completed: false,
                touched: Instant::now(),
            },
        );
        Ok(token)
    }
    fn cancel(&self, owner: &str, id: &str) -> Result<bool, Error> {
        validate_id(id)?;
        let mut registry = self.inner.0.lock()?;
        registry
            .jobs
            .retain(|_, job| job.active || job.touched.elapsed() < Duration::from_secs(300));
        if let Some(job) = registry.jobs.get(id) {
            return Ok(job.owner == owner && job.token.cancel());
        }
        if registry.closing || registry.jobs.len() >= 32 {
            return Ok(false);
        }
        let token = Arc::new(CancellationToken::default());
        token.cancel();
        registry.jobs.insert(
            id.to_owned(),
            Job {
                owner: owner.to_owned(),
                token,
                active: false,
                completed: false,
                touched: Instant::now(),
            },
        );
        Ok(true)
    }
    fn finish(&self, id: &str) {
        if let Ok(mut registry) = self.inner.0.lock() {
            if let Some(job) = registry.jobs.get_mut(id) {
                job.token.finish();
                job.active = false;
                job.completed = true;
                job.touched = Instant::now();
            }
            self.inner.1.notify_all();
        }
    }
    pub fn cancel_window(&self, owner: &str) {
        if let Ok(registry) = self.inner.0.lock() {
            for job in registry.jobs.values().filter(|j| j.owner == owner) {
                job.token.cancel();
            }
        }
    }
    /// Stops registration, cancels interruptible work and waits for real terminal outcomes.
    /// # Errors
    /// Returns an internal error if registry locking or the blocking waiter fails.
    pub async fn shutdown(&self) -> Result<(), AppError> {
        {
            let mut registry = self
                .inner
                .0
                .lock()
                .map_err(Error::from)
                .map_err(AppError::from)?;
            registry.closing = true;
            for job in registry.jobs.values() {
                job.token.cancel();
            }
        }
        let inner = self.inner.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), Error> {
            let mut registry = inner.0.lock()?;
            while registry.jobs.values().any(|job| job.active) {
                registry = inner.1.wait(registry)?;
            }
            Ok(())
        })
        .await
        .map_err(|_| AppError::new(ErrorCode::Internal, "Transfer shutdown failed"))?
        .map_err(AppError::from)
    }
}
fn validate_id(id: &str) -> Result<(), Error> {
    if id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Err(Error::invalid("jobId", "invalid job"))
    } else {
        Ok(())
    }
}
fn continue_job(token: &CancellationToken) -> Result<bool, Error> {
    match token.check() {
        Ok(()) => Ok(true),
        Err(Error::Cancelled) => Ok(false),
        Err(error) => Err(error),
    }
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), AppError> {
    if window.label() != "main" {
        Err(AppError::new(
            ErrorCode::Forbidden,
            "Transfer is restricted to the main window",
        ))
    } else {
        Ok(())
    }
}
struct ChannelProgress {
    channel: Channel<ProgressEvent>,
    token: Arc<CancellationToken>,
    last: Mutex<Option<(Instant, ProgressPhase, u64)>>,
}
impl ProgressSink for ChannelProgress {
    fn report(&self, event: &ProgressEvent) {
        let Ok(mut last) = self.last.lock() else {
            self.token.cancel();
            return;
        };
        if !event.terminal
            && last.as_ref().is_some_and(|(at, phase, _)| {
                *phase == event.phase && at.elapsed() < Duration::from_millis(100)
            })
        {
            return;
        }
        *last = Some((Instant::now(), event.phase, event.completed));
        if self.channel.send(event.clone()).is_err() {
            self.token.cancel();
        }
    }
}
impl ChannelProgress {
    fn terminal(&self, id: &str) {
        let (phase, completed) = self
            .last
            .lock()
            .ok()
            .and_then(|v| v.as_ref().map(|(_, p, c)| (*p, *c)))
            .unwrap_or((ProgressPhase::Finalizing, 0));
        self.report(&ProgressEvent {
            job_id: id.to_owned(),
            phase,
            completed,
            total: None,
            terminal: true,
        });
    }
}
struct JobGuard {
    registry: TransferJobs,
    id: String,
    progress: ChannelProgress,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        self.progress.terminal(&self.id);
        self.registry.finish(&self.id);
    }
}
#[derive(Serialize)]
pub struct Saved {
    saved: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportSource {
    Files,
    Folder,
}
#[tauri::command]
#[tracing::instrument(skip_all, fields(job_id = %job_id), err)]
pub async fn transfer_export(
    window: tauri::WebviewWindow,
    context: tauri::State<'_, AppContext>,
    jobs: tauri::State<'_, TransferJobs>,
    format: ExportFormat,
    job_id: String,
    channel: Channel<ProgressEvent>,
) -> Result<TransferOutcome<Saved>, AppError> {
    main_window(&window)?;
    let token = jobs
        .register(window.label(), &job_id)
        .map_err(AppError::from)?;
    let guard = JobGuard {
        registry: jobs.inner().clone(),
        id: job_id.clone(),
        progress: ChannelProgress {
            channel,
            token: token.clone(),
            last: Mutex::new(None),
        },
    };
    let app = window.app_handle().clone();
    let library = context.library.clone();
    let chinese = app
        .state::<crate::window::DesktopState>()
        .chinese
        .load(std::sync::atomic::Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || -> Result<TransferOutcome<Saved>, Error> {
        let guard = guard;
        if !continue_job(&token)? {
            return Ok(TransferOutcome::Cancelled);
        }
        let extension = match format {
            ExportFormat::Zip => "zip",
            ExportFormat::Json => "json",
        };
        let selection = app
            .dialog()
            .file()
            .set_title(if chinese {
                "导出 AutoNote"
            } else {
                "Export AutoNote"
            })
            .add_filter(
                if chinese {
                    "AutoNote 导出文件"
                } else {
                    "AutoNote export"
                },
                &[extension],
            )
            .set_file_name(format!("autonote-backup.{extension}"))
            .blocking_save_file();
        let Some(path) = selection else {
            return Ok(TransferOutcome::Cancelled);
        };
        if !continue_job(&token)? {
            return Ok(TransferOutcome::Cancelled);
        }
        let path = path
            .into_path()
            .map_err(|_| Error::invalid("format", "invalid dialog selection"))?;
        let service = TransferService::new(library, job_id)?;
        match service.export_to(
            AuthorizedOutput::open(&path)?,
            format,
            &guard.progress,
            &token,
        )? {
            TransferOutcome::Completed(_) => Ok(TransferOutcome::Completed(Saved { saved: true })),
            TransferOutcome::Cancelled => Ok(TransferOutcome::Cancelled),
        }
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::Internal, "Transfer task failed"))?
    .map_err(AppError::from)
}
#[tauri::command]
#[tracing::instrument(skip_all, fields(job_id = %job_id), err)]
pub async fn transfer_import(
    window: tauri::WebviewWindow,
    context: tauri::State<'_, AppContext>,
    jobs: tauri::State<'_, TransferJobs>,
    source: ImportSource,
    conflict: ImportConflict,
    job_id: String,
    channel: Channel<ProgressEvent>,
) -> Result<TransferOutcome<ImportResult>, AppError> {
    main_window(&window)?;
    let token = jobs
        .register(window.label(), &job_id)
        .map_err(AppError::from)?;
    let guard = JobGuard {
        registry: jobs.inner().clone(),
        id: job_id.clone(),
        progress: ChannelProgress {
            channel,
            token: token.clone(),
            last: Mutex::new(None),
        },
    };
    let app = window.app_handle().clone();
    let library = context.library.clone();
    let chinese = app
        .state::<crate::window::DesktopState>()
        .chinese
        .load(std::sync::atomic::Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = guard;
        if !continue_job(&token)? {
            return Ok(TransferOutcome::Cancelled);
        }
        let input = match source {
            ImportSource::Files => {
                let Some(paths) = app
                    .dialog()
                    .file()
                    .set_title(if chinese {
                        "导入 AutoNote 或 Markdown"
                    } else {
                        "Import AutoNote or Markdown"
                    })
                    .add_filter(
                        if chinese {
                            "笔记与备份"
                        } else {
                            "Notes and backups"
                        },
                        &["zip", "json", "md", "markdown", "txt"],
                    )
                    .blocking_pick_files()
                else {
                    return Ok(TransferOutcome::Cancelled);
                };
                if !continue_job(&token)? {
                    return Ok(TransferOutcome::Cancelled);
                }
                let paths = paths
                    .into_iter()
                    .map(|p| {
                        p.into_path()
                            .map_err(|_| Error::invalid("source", "invalid dialog selection"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                AuthorizedInput::open_files(paths)?
            }
            ImportSource::Folder => {
                let Some(path) = app
                    .dialog()
                    .file()
                    .set_title(if chinese {
                        "导入备份文件夹或 Obsidian 知识库"
                    } else {
                        "Import backup folder or Obsidian vault"
                    })
                    .blocking_pick_folder()
                else {
                    return Ok(TransferOutcome::Cancelled);
                };
                if !continue_job(&token)? {
                    return Ok(TransferOutcome::Cancelled);
                }
                AuthorizedInput::open_folder(
                    &path
                        .into_path()
                        .map_err(|_| Error::invalid("source", "invalid dialog selection"))?,
                )?
            }
        };
        TransferService::new(library, job_id)?.import_from(input, conflict, &guard.progress, &token)
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::Internal, "Transfer task failed"))?
    .map_err(AppError::from)
}
#[tauri::command]
#[tracing::instrument(skip_all, fields(job_id = %job_id), err)]
pub async fn transfer_cancel(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, TransferJobs>,
    job_id: String,
) -> Result<bool, AppError> {
    main_window(&window)?;
    jobs.cancel(window.label(), &job_id).map_err(AppError::from)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "transfer job lifecycle assertions")]
mod tests {
    use super::*;
    #[test]
    fn pre_cancel_owner_commit_and_completion_races_are_explicit() {
        let jobs = TransferJobs::default();
        assert!(jobs.cancel("main", "pre-cancel").unwrap());
        let token = jobs.register("main", "pre-cancel").unwrap();
        assert!(token.check().is_err());
        assert!(!jobs.cancel("other", "pre-cancel").unwrap());
        jobs.finish("pre-cancel");
        assert!(!jobs.cancel("main", "pre-cancel").unwrap());
        assert!(jobs.register("main", "pre-cancel").is_err());
        let token = jobs.register("main", "shutdown-job").unwrap();
        jobs.cancel_window("main");
        assert!(token.check().is_err());
        jobs.finish("shutdown-job");
        if let Ok(mut registry) = jobs.inner.0.lock() {
            registry.closing = true;
        } else {
            assert!(
                jobs.register("main", "poisoned").is_ok(),
                "registry poisoned"
            );
        }
        assert!(jobs.register("main", "after-close").is_err());
        assert!(!jobs.cancel("main", "after-close").unwrap());
    }
}
