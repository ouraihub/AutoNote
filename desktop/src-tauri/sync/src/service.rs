//! One durable binding and one serial engine. Network cancellation never erases writes.
use crate::{
    SessionCookie, SiteOrigin,
    remote::{self, CallOptions, PasswordLoginResult, RemoteClient},
};
use note_core::sync::{BindPolicy, Binding, SyncCookie};
use note_core::{AppError, ErrorCode, Library};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub trait SecretStore: Send + Sync {
    /// Protects secret bytes for durable storage.
    ///
    /// # Errors
    /// Returns an application error when the platform secret store rejects the operation.
    fn protect(&self, value: &[u8]) -> Result<Vec<u8>, AppError>;
    /// Restores secret bytes from durable storage.
    ///
    /// # Errors
    /// Returns an application error when the platform secret store rejects or cannot decode the value.
    fn unprotect(&self, value: &[u8]) -> Result<Vec<u8>, AppError>;
}
pub trait StatusSink: Send + Sync {
    fn changed(&self, status: &SyncStatus);
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
pub enum BindStrategy {
    #[serde(rename = "keep-local")]
    KeepLocal,
    #[serde(rename = "import-remote")]
    ImportRemote,
    #[serde(rename = "merge")]
    Merge,
}
impl BindStrategy {
    fn policy(self) -> BindPolicy {
        match self {
            Self::KeepLocal => BindPolicy::ExportLocal,
            Self::ImportRemote => BindPolicy::ImportCopies,
            Self::Merge => BindPolicy::Merge,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginReply {
    pub login_id: String,
    pub result: Value,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCounts {
    pub local: u64,
    pub remote: u64,
    pub matched: u64,
    pub conflicts: u64,
    pub attachments: u64,
    pub network_writes: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindPreview {
    pub preview_id: String,
    pub counts: PreviewCounts,
    pub expires_at: i64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub binding_id: Option<String>,
    pub epoch: Option<i64>,
    pub phase: String,
    pub local_cursor: i64,
    pub remote_cursor: i64,
    pub pending: u64,
    pub blocked: u64,
    pub conflicts: u64,
    pub online: bool,
    pub error_code: Option<String>,
    pub terminal: bool,
    pub site_origin: Option<String>,
    pub account_hint: Option<String>,
    pub metadata_risk: bool,
    pub conflict_items: Vec<note_core::sync::ConflictSummary>,
    pub quarantined: Vec<note_core::sync::QuarantinedSummary>,
}
struct Login {
    remote: Arc<RemoteClient>,
    user: Option<remote::PublicUser>,
    expires: Instant,
}
struct Preview {
    remote: Arc<RemoteClient>,
    user: remote::PublicUser,
    strategy: BindStrategy,
    snapshot: crate::pull::CollectedSnapshot,
    expires: Instant,
}
struct Runtime {
    cancel: CancellationToken,
    id: String,
}
pub struct SyncService {
    library: Arc<Library>,
    secrets: Arc<dyn SecretStore>,
    sink: Arc<dyn StatusSink>,
    serial: Mutex<()>,
    logins: Mutex<HashMap<String, Login>>,
    previews: Mutex<HashMap<String, Preview>>,
    runtime: Mutex<Option<Runtime>>,
    active: Mutex<Option<CancellationToken>>,
    wake: Notify,
    shutting_down: AtomicBool,
}
fn error(code: ErrorCode, message: &'static str) -> AppError {
    AppError::new(code, message)
}
/// Runs a local library transaction on the blocking executor.
///
/// # Errors
/// Returns an internal error if the executor fails, or the library transaction error.
pub async fn blocking<T: Send + 'static>(
    library: &Arc<Library>,
    work: impl FnOnce(&Library) -> Result<T, note_core::Error> + Send + 'static,
) -> Result<T, AppError> {
    let library = library.clone();
    tokio::task::spawn_blocking(move || work(&library))
        .await
        .map_err(|_| error(ErrorCode::Internal, "Sync local transaction failed"))?
        .map_err(AppError::from)
}
impl SyncService {
    /// Creates a synchronization service.
    ///
    /// # Errors
    /// Returns an error if service initialization fails.
    pub fn new(
        library: Arc<Library>,
        secrets: Arc<dyn SecretStore>,
        sink: Arc<dyn StatusSink>,
    ) -> Result<Arc<Self>, AppError> {
        Ok(Arc::new(Self {
            library,
            secrets,
            sink,
            serial: Mutex::new(()),
            logins: Mutex::new(HashMap::new()),
            previews: Mutex::new(HashMap::new()),
            runtime: Mutex::new(None),
            active: Mutex::new(None),
            wake: Notify::new(),
            shutting_down: AtomicBool::new(false),
        }))
    }
    fn ensure_running(&self) -> Result<(), AppError> {
        if self.shutting_down.load(Ordering::Acquire) {
            Err(error(ErrorCode::Cancelled, "Sync service is shutting down"))
        } else {
            Ok(())
        }
    }
    async fn id(&self) -> Result<String, AppError> {
        self.ensure_running()?;
        blocking(&self.library, Library::sync_new_id).await
    }
    /// Starts a password login flow.
    ///
    /// # Errors
    /// Returns validation, network, authentication, storage, or serialization errors.
    pub async fn login(
        &self,
        origin: &str,
        username: &str,
        password: &str,
        options: &CallOptions,
    ) -> Result<LoginReply, AppError> {
        self.ensure_running()?;
        if username.is_empty()
            || username.len() > 128
            || password.is_empty()
            || password.len() > 4096
        {
            return Err(error(ErrorCode::BadRequest, "Invalid sync login input"));
        }
        let password = Zeroizing::new(password.to_owned());
        let client = Arc::new(RemoteClient::new(SiteOrigin::parse(origin)?, None)?);
        let result = client
            .login(username, &password, options)
            .await
            .map_err(|error| error.app_error())?;
        let user = match &result {
            PasswordLoginResult::Session(session) => {
                Some(session.user.clone().ok_or_else(|| {
                    error(ErrorCode::Unauthenticated, "Remote session has no user")
                })?)
            }
            PasswordLoginResult::Challenge(_) => None,
        };
        let id = self.id().await?;
        let reply = LoginReply {
            login_id: id.clone(),
            result: serde_json::to_value(result)
                .map_err(|_| error(ErrorCode::InvalidResponse, "Invalid login response"))?,
        };
        let mut logins = self.logins.lock().await;
        logins.retain(|_, login| login.expires > Instant::now());
        logins.insert(
            id,
            Login {
                remote: client,
                user,
                expires: Instant::now() + Duration::from_secs(600),
            },
        );
        Ok(reply)
    }
    /// Completes a two-factor login flow.
    ///
    /// # Errors
    /// Returns an expired-login, authentication, network, storage, or serialization error.
    pub async fn complete_totp(
        &self,
        login_id: &str,
        challenge: &str,
        code: &str,
        options: &CallOptions,
    ) -> Result<LoginReply, AppError> {
        self.ensure_running()?;
        let client = {
            let logins = self.logins.lock().await;
            let login = logins
                .get(login_id)
                .filter(|login| login.expires > Instant::now())
                .ok_or_else(|| error(ErrorCode::NotFound, "Sync login expired"))?;
            login.remote.clone()
        };
        let result = client
            .complete_totp(challenge, code, options)
            .await
            .map_err(|error| error.app_error())?;
        let user = result
            .session
            .user
            .clone()
            .ok_or_else(|| error(ErrorCode::Unauthenticated, "Remote session has no user"))?;
        self.logins
            .lock()
            .await
            .get_mut(login_id)
            .ok_or_else(|| error(ErrorCode::NotFound, "Sync login expired"))?
            .user = Some(user);
        Ok(LoginReply {
            login_id: login_id.to_owned(),
            result: serde_json::to_value(result)
                .map_err(|_| error(ErrorCode::InvalidResponse, "Invalid login response"))?,
        })
    }
    /// Previews a binding strategy without writing local state.
    ///
    /// # Errors
    /// Returns an expired-login, authentication, network, storage, or synchronization error.
    pub async fn preview(
        &self,
        login_id: &str,
        strategy: BindStrategy,
        options: &CallOptions,
    ) -> Result<BindPreview, AppError> {
        self.ensure_running()?;
        let (client, user) = {
            let logins = self.logins.lock().await;
            let login = logins
                .get(login_id)
                .filter(|login| login.expires > Instant::now())
                .ok_or_else(|| error(ErrorCode::NotFound, "Sync login expired"))?;
            (
                login.remote.clone(),
                login.user.clone().ok_or_else(|| {
                    error(
                        ErrorCode::Unauthenticated,
                        "Complete two-factor login first",
                    )
                })?,
            )
        };
        let local = blocking(&self.library, Library::notes_snapshot).await?;
        let snapshot = crate::pull::collect(&client, options)
            .await
            .map_err(|error| error.app_error())?;
        let mut matched = 0;
        let mut conflicts = 0;
        for remote in &snapshot.notes {
            if let Some(summary) = local
                .notes
                .iter()
                .find(|summary| summary.id == remote.summary.id)
            {
                let id = summary.id.clone();
                let note = blocking(&self.library, move |library| library.get_note(&id)).await?;
                if note.content == remote.content
                    && note.summary.title == remote.summary.title
                    && note.summary.folder_id == remote.summary.folder_id
                    && note.summary.is_starred == remote.summary.is_starred
                    && note.summary.is_pinned == remote.summary.is_pinned
                    && note.summary.is_archived == remote.summary.is_archived
                    && note.summary.deleted_at == remote.summary.deleted_at
                {
                    matched += 1;
                } else {
                    conflicts += 1;
                }
            }
        }
        let attachment_count = crate::attachments::remote_attachment_count(&client, options)
            .await
            .map_err(|error| error.app_error())?;
        let id = self.id().await?;
        let reply = BindPreview {
            preview_id: id.clone(),
            counts: PreviewCounts {
                local: local.notes.len() as u64,
                remote: snapshot.notes.len() as u64,
                matched,
                conflicts,
                attachments: attachment_count,
                network_writes: if strategy == BindStrategy::ImportRemote {
                    0
                } else {
                    local.notes.len() as u64 - matched
                },
            },
            expires_at: remote::now()?.get() + 300_000,
        };
        let mut previews = self.previews.lock().await;
        previews.retain(|_, preview| preview.expires > Instant::now());
        previews.insert(
            id,
            Preview {
                remote: client,
                user,
                strategy,
                snapshot,
                expires: Instant::now() + Duration::from_secs(300),
            },
        );
        Ok(reply)
    }
    /// Commits a previously generated binding preview.
    ///
    /// # Errors
    /// Returns preview, authentication, conflict, network, attachment, or local transaction errors.
    pub async fn confirm(
        &self,
        preview_id: &str,
        options: &CallOptions,
    ) -> Result<SyncStatus, AppError> {
        self.ensure_running()?;
        self.stop().await?;
        let _serial = self.serial.lock().await;
        let preview = self
            .previews
            .lock()
            .await
            .remove(preview_id)
            .filter(|preview| preview.expires > Instant::now())
            .ok_or_else(|| error(ErrorCode::Conflict, "Sync preview expired; preview again"))?;
        let session = preview
            .remote
            .validate_session(options)
            .await
            .map_err(|error| error.app_error())?;
        if session
            .user
            .as_ref()
            .is_none_or(|user| user.id != preview.user.id)
        {
            return Err(error(ErrorCode::Unauthenticated, "Remote account changed"));
        }
        let latest = preview
            .remote
            .sync_page(preview.snapshot.page.cursor.get(), None, None, options)
            .await
            .map_err(|error| error.app_error())?;
        if latest.full
            || latest.cursor != preview.snapshot.page.cursor
            || !latest.notes.is_empty()
            || !latest.deletions.is_empty()
        {
            return Err(error(ErrorCode::Conflict, "Remote changed; preview again"));
        }
        let prior = blocking(&self.library, Library::sync_current_binding).await?;
        let binding = Binding {
            binding_id: self.id().await?,
            binding_epoch: prior
                .as_ref()
                .map_or(1, |state| state.binding.binding_epoch + 1),
            site_origin: preview
                .remote
                .origin()
                .as_url()
                .origin()
                .ascii_serialization(),
            account_hint: preview.user.username.clone(),
            remote_user_id: preview.user.id.clone(),
        };
        let cookie = self.protected_cookie(&preview.remote)?;
        let mut notes = Vec::with_capacity(preview.snapshot.notes.len());
        for note in &preview.snapshot.notes {
            notes.push(
                crate::attachments::materialize_note(
                    &self.library,
                    &preview.remote,
                    &binding,
                    note,
                    options,
                )
                .await
                .map_err(|error| error.app_error())?,
            );
        }
        let binding_copy = binding.clone();
        let policy = preview.strategy.policy();
        let snapshot = note_core::sync::BindingSnapshot {
            notes,
            folders: preview.snapshot.page.folders.clone(),
            tags: preview.snapshot.page.tags.clone(),
            cursor: preview.snapshot.page.cursor.get(),
        };
        blocking(&self.library, move |library| {
            library.sync_confirm_binding(&binding_copy, &cookie, policy, &snapshot)
        })
        .await?;
        self.publish().await
    }
    fn protected_cookie(&self, client: &RemoteClient) -> Result<SyncCookie, AppError> {
        let record = client
            .cookie_record()?
            .ok_or_else(|| error(ErrorCode::Unauthenticated, "No authenticated sync cookie"))?;
        let bytes = Zeroizing::new(
            serde_json::to_vec(&record)
                .map_err(|_| error(ErrorCode::Internal, "Session serialization failed"))?,
        );
        Ok(SyncCookie {
            ciphertext: Some(self.secrets.protect(&bytes)?),
            domain: record.domain.clone(),
            path: record.path.clone(),
            expires_at: record.expires_at,
            secure: record.secure,
            host_only: record.host_only,
            name: record.name.clone(),
            same_site: record.same_site.clone(),
        })
    }
    async fn client(&self, state: &note_core::sync::SyncState) -> Result<RemoteClient, AppError> {
        let ciphertext = state
            .cookie
            .ciphertext
            .as_ref()
            .ok_or_else(|| error(ErrorCode::Unauthenticated, "Sync credentials unavailable"))?;
        let bytes = Zeroizing::new(self.secrets.unprotect(ciphertext)?);
        let record: crate::session::CookieRecord = serde_json::from_slice(&bytes)
            .map_err(|_| error(ErrorCode::StorageUnavailable, "Sync credentials invalid"))?;
        let origin = SiteOrigin::parse(&state.binding.site_origin)?;
        RemoteClient::new(
            origin.clone(),
            Some(SessionCookie::from_record(
                &origin,
                &record,
                remote::now()?,
            )?),
        )
    }
    /// Returns the current synchronization status.
    ///
    /// # Errors
    /// Returns a local library or status transaction error.
    pub async fn status(&self) -> Result<SyncStatus, AppError> {
        let status = blocking(&self.library, Library::sync_status).await?;
        let local_cursor = blocking(&self.library, Library::notes_snapshot)
            .await?
            .cursor
            .get();
        let conflict_items = blocking(&self.library, Library::sync_conflicts).await?;
        let quarantined = blocking(&self.library, Library::sync_quarantined).await?;
        Ok(SyncStatus {
            binding_id: status
                .state
                .as_ref()
                .map(|state| state.binding.binding_id.clone()),
            epoch: status
                .state
                .as_ref()
                .map(|state| state.binding.binding_epoch),
            phase: status
                .state
                .as_ref()
                .map_or_else(|| "unbound".to_owned(), |state| state.status.clone()),
            local_cursor,
            remote_cursor: status.state.as_ref().map_or(0, |state| state.cursor),
            pending: status.pending,
            blocked: status.blocked,
            conflicts: status.conflicts,
            online: status
                .state
                .as_ref()
                .is_some_and(|state| state.last_error_code.is_none()),
            error_code: status
                .state
                .as_ref()
                .and_then(|state| state.last_error_code.clone()),
            terminal: self.runtime.lock().await.is_none(),
            site_origin: status
                .state
                .as_ref()
                .map(|state| state.binding.site_origin.clone()),
            account_hint: status
                .state
                .as_ref()
                .map(|state| state.binding.account_hint.clone()),
            // metadata has no server CAS; any parked metadata conflict means remote may still race.
            metadata_risk: conflict_items
                .iter()
                .any(|item| item.reason == "metadata_conflict"),
            conflict_items,
            quarantined,
        })
    }
    async fn publish(&self) -> Result<SyncStatus, AppError> {
        let status = self.status().await?;
        self.sink.changed(&status);
        Ok(status)
    }
    /// Runs one synchronization cycle.
    ///
    /// # Errors
    /// Returns binding, authentication, network, cancellation, attachment, or local transaction errors.
    pub async fn now(&self, options: &CallOptions) -> Result<SyncStatus, AppError> {
        self.ensure_running()?;
        let _serial = self.serial.lock().await;
        let options = CallOptions {
            cancel: options.cancel.child_token(),
            deadline: options.deadline,
        };
        *self.active.lock().await = Some(options.cancel.clone());
        let options = &options;
        let state = blocking(&self.library, Library::sync_current_binding)
            .await?
            .ok_or_else(|| error(ErrorCode::BadRequest, "Sync is not bound"))?;
        let binding = state.binding.clone();
        let result = async {
            let remote = self.client(&state).await?;
            let session = remote
                .validate_session(options)
                .await
                .map_err(|error| error.app_error())?;
            if session
                .user
                .as_ref()
                .is_none_or(|user| user.id != binding.remote_user_id)
            {
                return Err(error(ErrorCode::Unauthenticated, "Remote account changed"));
            }
            let copy = binding.clone();
            blocking(&self.library, move |library| {
                library.sync_set_status(&copy, "pulling", None)
            })
            .await?;
            self.publish().await?;
            crate::attachments::recover(&self.library, &binding)
                .await
                .map_err(|error| error.app_error())?;
            crate::pull::pull(&self.library, &remote, &binding, options).await?;
            let copy = binding.clone();
            blocking(&self.library, move |library| {
                library.sync_set_status(&copy, "pushing", None)
            })
            .await?;
            self.publish().await?;
            crate::push::push(&self.library, &remote, &binding, options).await?;
            let cookie = self.protected_cookie(&remote)?;
            let copy = binding.clone();
            blocking(&self.library, move |library| {
                library.sync_update_cookie(&copy, &cookie)
            })
            .await?;
            Ok::<(), AppError>(())
        }
        .await;
        self.active.lock().await.take();
        let copy = binding.clone();
        let code = result
            .as_ref()
            .err()
            .map(|error| error.code().as_str().to_owned());
        blocking(&self.library, move |library| {
            library.sync_set_status(
                &copy,
                if code.is_some() { "paused" } else { "idle" },
                code.as_deref(),
            )
        })
        .await?;
        self.publish().await?;
        result?;
        self.status().await
    }
    /// Starts background synchronization for the current binding.
    ///
    /// # Errors
    /// Returns a shutdown, binding, or local transaction error.
    pub async fn start(self: &Arc<Self>) -> Result<SyncStatus, AppError> {
        self.ensure_running()?;
        let mut runtime = self.runtime.lock().await;
        if blocking(&self.library, Library::sync_current_binding)
            .await?
            .is_none()
        {
            return Err(error(ErrorCode::BadRequest, "Sync is not bound"));
        }
        let cancel = CancellationToken::new();
        let id = self.id().await?;
        *runtime = Some(Runtime {
            cancel: cancel.clone(),
            id: id.clone(),
        });
        let service = self.clone();
        tokio::spawn(async move {
            service.run(cancel, id).await;
        });
        drop(runtime);
        self.publish().await
    }
    async fn run(self: Arc<Self>, cancel: CancellationToken, id: String) {
        let mut subscription = None;
        let mut failures: u32 = 0;
        while !cancel.is_cancelled() {
            let options = CallOptions {
                cancel: cancel.clone(),
                deadline: Instant::now() + Duration::from_secs(60),
            };
            let result = self.now(&options).await;
            if cancel.is_cancelled() {
                break;
            }
            if let Err(error) = &result {
                if matches!(
                    error.code(),
                    ErrorCode::Unauthenticated
                        | ErrorCode::Forbidden
                        | ErrorCode::Conflict
                        | ErrorCode::StorageUnavailable
                        | ErrorCode::InvalidResponse
                ) {
                    break;
                }
                failures = failures.saturating_add(1);
                subscription = None;
            } else {
                failures = 0;
            }
            let settings = blocking(&self.library, Library::settings_get).await;
            let poll = settings
                .as_ref()
                .map_or(30_000, |settings| settings.sync.poll_interval_ms);
            if subscription.is_none()
                && settings
                    .as_ref()
                    .is_ok_and(|settings| settings.sync.realtime)
                && let Ok(Some(state)) =
                    blocking(&self.library, Library::sync_current_binding).await
                && let Ok(client) = self.client(&state).await
            {
                subscription = client.subscribe_changes(&options).await.ok();
                if subscription.is_some() {
                    continue;
                } // Reconnected: pull before consuming notifications.
            }
            // ponytail: millisecond jitter is sufficient for one desktop; use OS randomness for a fleet scheduler.
            let jitter = remote::now().map_or(0, |now| now.get() as u64 % 1000);
            let delay = Duration::from_millis(if failures > 0 {
                (1000_u64 << failures.min(6)).min(60_000) + jitter
            } else {
                poll as u64 + jitter
            });
            let heartbeat = CallOptions {
                cancel: cancel.clone(),
                deadline: Instant::now() + delay,
            };
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = self.wake.notified() => {},
                _ = tokio::time::sleep(delay) => {},
                message = async { if let Some(socket) = subscription.as_mut() { socket.changed(&heartbeat).await } else { std::future::pending().await } } => { if message.is_err() { subscription = None; failures = failures.saturating_add(1); } },
            }
        }
        let mut runtime = self.runtime.lock().await;
        if runtime.as_ref().is_some_and(|runtime| runtime.id == id) {
            runtime.take();
        }
        drop(runtime);
        let _ = self.publish().await;
    }
    /// Stops background and active synchronization.
    ///
    /// # Errors
    /// Returns a status or local transaction error.
    pub async fn stop(&self) -> Result<SyncStatus, AppError> {
        if let Some(runtime) = self.runtime.lock().await.take() {
            runtime.cancel.cancel();
        }
        if let Some(active) = self.active.lock().await.take() {
            active.cancel();
        }
        let _serial = self.serial.lock().await;
        self.publish().await
    }
    /// Stops synchronization and retains outstanding writes in quarantine.
    /// # Errors
    /// Rejects changed binding epochs and propagates local transaction/status errors.
    pub async fn unbind(&self, id: &str, epoch: i64) -> Result<SyncStatus, AppError> {
        self.stop().await?;
        let _serial = self.serial.lock().await;
        let binding = self.require_binding(id, epoch).await?;
        blocking(&self.library, move |library| {
            library.sync_quarantine(&binding)
        })
        .await?;
        self.publish().await
    }
    async fn require_binding(&self, id: &str, epoch: i64) -> Result<Binding, AppError> {
        let state = blocking(&self.library, Library::sync_current_binding)
            .await?
            .ok_or_else(|| error(ErrorCode::Conflict, "Sync binding changed"))?;
        if state.binding.binding_id != id || state.binding.binding_epoch != epoch {
            return Err(error(ErrorCode::Conflict, "Sync binding changed"));
        }
        Ok(state.binding)
    }
    /// Resolves a conflict using local, remote, or a retained remote note copy.
    ///
    /// # Errors
    /// Returns invalid-choice, stale-binding, unsafe-resolution or local transaction errors.
    pub async fn resolve_conflict(
        &self,
        id: &str,
        choice: &str,
        binding_id: &str,
        epoch: i64,
    ) -> Result<SyncStatus, AppError> {
        let _serial = self.serial.lock().await;
        let binding = self.require_binding(binding_id, epoch).await?;
        if !matches!(choice, "local" | "remote" | "keep-both") {
            return Err(error(ErrorCode::BadRequest, "Invalid conflict choice"));
        }
        let conflict_id = id.to_owned();
        let conflict_choice = choice.to_owned();
        blocking(&self.library, move |library| {
            library.sync_resolve_conflict(&binding, &conflict_id, &conflict_choice)
        })
        .await?;
        self.publish().await
    }
    /// Exports retained writes from the requested current binding epoch.
    /// # Errors
    /// Returns stale-binding, database or payload decoding errors.
    pub async fn export_quarantined(&self, id: &str, epoch: i64) -> Result<Value, AppError> {
        let binding = self.require_binding(id, epoch).await?;
        blocking(&self.library, move |library| {
            library.sync_export_outbox(&binding.binding_id, binding.binding_epoch)
        })
        .await
    }
    /// Explicitly discards quarantined writes from the current binding epoch.
    /// # Errors
    /// Returns stale-binding or local transaction errors.
    pub async fn discard_quarantined(&self, id: &str, epoch: i64) -> Result<SyncStatus, AppError> {
        let _serial = self.serial.lock().await;
        let binding = self.require_binding(id, epoch).await?;
        blocking(&self.library, move |library| {
            library.sync_discard_outbox(&binding.binding_id, binding.binding_epoch)
        })
        .await?;
        self.publish().await
    }
    /// Permanently shuts down synchronization.
    ///
    /// # Errors
    /// Returns a local synchronization shutdown error.
    pub async fn shutdown(&self) -> Result<(), AppError> {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        if let Some(runtime) = self.runtime.lock().await.take() {
            runtime.cancel.cancel();
        }
        if let Some(active) = self.active.lock().await.take() {
            active.cancel();
        }
        let _serial = self.serial.lock().await;
        self.logins.lock().await.clear();
        self.previews.lock().await.clear();
        Ok(())
    }
}
