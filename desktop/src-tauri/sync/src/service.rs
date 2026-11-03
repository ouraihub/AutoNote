//! One binding, one background loop, one serial round: pull, then push (22 §7.6).
use crate::{
    SessionCookie, SiteOrigin,
    remote::{self, CallOptions, PasswordLoginResult, RemoteClient},
};
use note_core::sync::{Binding, BindingState, MergeCounts, RemoteBatch, SyncCookie};
#[path = "runtime.rs"]
mod runtime;
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
    /// Returns an application error when the platform secret store rejects or
    /// cannot decode the value.
    fn unprotect(&self, value: &[u8]) -> Result<Vec<u8>, AppError>;
}
pub trait StatusSink: Send + Sync {
    fn changed(&self, status: &SyncStatus);
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginReply {
    pub login_id: String,
    pub result: Value,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindPreview {
    pub preview_id: String,
    #[serde(flatten)]
    pub counts: MergeCounts,
    pub expires_at: i64,
}
/// Settings-page view of sync; never contains cookies or note bodies.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// `unbound`, `idle`, `syncing` or `paused`; memory only.
    pub phase: &'static str,
    pub site_origin: Option<String>,
    pub account: Option<String>,
    pub cursor: i64,
    pub pending: u64,
    pub last_success_at: Option<i64>,
    pub error_code: Option<String>,
}
struct Login {
    remote: Arc<RemoteClient>,
    user: Option<remote::PublicUser>,
    expires: Instant,
}
struct Preview {
    remote: Arc<RemoteClient>,
    user: remote::PublicUser,
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
    syncing: AtomicBool,
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
            syncing: AtomicBool::new(false),
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
    /// Asks the background loop for a round soon; repeated calls coalesce.
    pub fn wake(&self) {
        self.wake.notify_one();
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
    /// Reads the remote snapshot and compares it with local notes by id; writes nothing.
    ///
    /// # Errors
    /// Returns an expired-login, authentication, network or local read error.
    pub async fn preview(
        &self,
        login_id: &str,
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
        let snapshot = crate::pull::collect(&client, options)
            .await
            .map_err(|error| error.app_error())?;
        let remote_notes = snapshot.notes.clone();
        let counts = blocking(&self.library, move |lib| {
            lib.sync_merge_counts(&remote_notes)
        })
        .await?;
        let id = self.id().await?;
        let reply = BindPreview {
            preview_id: id.clone(),
            counts,
            expires_at: remote::now()?.get() + 300_000,
        };
        let mut previews = self.previews.lock().await;
        previews.retain(|_, preview| preview.expires > Instant::now());
        previews.insert(
            id,
            Preview {
                remote: client,
                user,
                snapshot,
                expires: Instant::now() + Duration::from_secs(300),
            },
        );
        Ok(reply)
    }
    /// Binds by merging the previewed snapshot (22 §6.4), then starts syncing.
    ///
    /// # Errors
    /// Returns preview-expired, remote-changed, authentication, network, attachment
    /// or local transaction errors; nothing is bound on failure.
    pub async fn confirm(
        self: &Arc<Self>,
        preview_id: &str,
        options: &CallOptions,
    ) -> Result<SyncStatus, AppError> {
        self.ensure_running()?;
        let preview = self
            .previews
            .lock()
            .await
            .remove(preview_id)
            .filter(|preview| preview.expires > Instant::now())
            .ok_or_else(|| error(ErrorCode::Conflict, "Sync preview expired; preview again"))?;
        {
            let _serial = self.serial.lock().await;
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
            if latest.full || latest.cursor != preview.snapshot.page.cursor {
                return Err(error(ErrorCode::Conflict, "Remote changed; preview again"));
            }
            let mut notes = Vec::with_capacity(preview.snapshot.notes.len());
            for note in &preview.snapshot.notes {
                notes.push(
                    crate::attachments::materialize_note(
                        &self.library,
                        &preview.remote,
                        note,
                        options,
                    )
                    .await
                    .map_err(|error| error.app_error())?,
                );
            }
            let binding = Binding {
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
            let snapshot = RemoteBatch {
                cursor: preview.snapshot.page.cursor.get(),
                full: true,
                notes,
                folders: preview.snapshot.page.folders.clone(),
                tags: preview.snapshot.page.tags.clone(),
                deletions: Vec::new(),
            };
            blocking(&self.library, move |lib| {
                lib.sync_bind(&binding, &cookie, &snapshot)
            })
            .await?;
            tracing::info!("sync.bound");
        }
        self.start().await
    }
    /// Stops syncing and removes the binding; local data stays and becomes pending.
    ///
    /// # Errors
    /// Returns a local transaction error.
    pub async fn unbind(&self) -> Result<SyncStatus, AppError> {
        self.stop().await?;
        let _serial = self.serial.lock().await;
        blocking(&self.library, Library::sync_unbind).await?;
        tracing::info!("sync.unbound");
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
            ciphertext: self.secrets.protect(&bytes)?,
            name: record.name.clone(),
            domain: record.domain.clone(),
            path: record.path.clone(),
            expires_at: record.expires_at,
            secure: record.secure,
            host_only: record.host_only,
            same_site: record.same_site.clone(),
        })
    }
    fn client(&self, state: &BindingState) -> Result<RemoteClient, AppError> {
        let bytes = Zeroizing::new(self.secrets.unprotect(&state.cookie.ciphertext)?);
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
}
/// 2 s, 4 s, … capped at 60 s.
fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((2000_u64 << attempt.saturating_sub(1).min(5)).min(60_000))
}

#[cfg(test)]
mod tests {
    #[test]
    fn retry_delay_grows_and_caps() {
        assert_eq!(super::backoff(1).as_secs(), 2);
        assert_eq!(super::backoff(2).as_secs(), 4);
        assert_eq!(super::backoff(30).as_secs(), 60);
    }
}
