//! Existing Worker API, with explicit cookie ownership and no automatic redirects.
use crate::{SessionCookie, SiteOrigin};
use note_core::{
    AppError, Attachment, AttachmentWithUsage, ErrorCode, Folder, Millis, Note, SyncResponse, Tag,
};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    time::{Duration, Instant},
};
#[path = "remote_client.rs"]
mod remote_client;
pub use remote_client::RemoteClient;
#[path = "remote_api.rs"]
mod remote_api;
#[path = "websocket.rs"]
mod websocket;
use tokio_util::sync::CancellationToken;
pub use websocket::ChangeSubscription;

pub const ATTACHMENT_MAX_BYTES: usize = 25 * 1024 * 1024;
const JSON_MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct CallOptions {
    pub cancel: CancellationToken,
    pub deadline: Instant,
}
impl Default for CallOptions {
    fn default() -> Self {
        Self {
            cancel: CancellationToken::new(),
            deadline: Instant::now() + Duration::from_secs(60),
        }
    }
}
impl CallOptions {
    /// Runs a request until cancellation, deadline, or completion.
    ///
    /// # Errors
    /// Returns the request error, cancellation, or deadline timeout.
    pub async fn run<T>(
        &self,
        future: impl Future<Output = Result<T, RemoteError>>,
    ) -> Result<T, RemoteError> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(RemoteError::new(ErrorCode::Cancelled)),
            result = tokio::time::timeout_at(self.deadline.into(), future) => {
                result.unwrap_or_else(|_| Err(RemoteError::new(ErrorCode::RequestTimeout)))
            },
        }
    }
}

// Remote bodies are intentionally excluded from Debug/logging.
pub struct RemoteError {
    pub code: ErrorCode,
    pub server: Option<Box<Note>>,
    pub retry_after: Option<u64>,
}
impl RemoteError {
    /// Creates an error for a remote operation failure.
    pub fn new(code: ErrorCode) -> Self {
        Self {
            code,
            server: None,
            retry_after: None,
        }
    }
    /// Converts this remote failure to the public application error.
    pub fn app_error(&self) -> AppError {
        AppError::new(self.code, "Remote synchronization request failed")
    }
}
impl std::fmt::Debug for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteError")
            .field("code", &self.code)
            .field("retry_after", &self.retry_after)
            .finish_non_exhaustive()
    }
}
impl From<AppError> for RemoteError {
    fn from(error: AppError) -> Self {
        Self::new(error.code())
    }
}
fn network(error: reqwest::Error) -> RemoteError {
    RemoteError::new(if error.is_timeout() {
        ErrorCode::RequestTimeout
    } else {
        ErrorCode::Offline
    })
}
/// Returns the current UNIX time in milliseconds.
///
/// # Errors
/// Returns an error when the system clock is before UNIX epoch or outside the supported range.
pub fn now() -> Result<Millis, AppError> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| AppError::new(ErrorCode::Internal, "System clock unavailable"))?;
    Millis::new(
        i64::try_from(elapsed.as_millis()).map_err(|_| {
            AppError::new(ErrorCode::Internal, "System clock outside supported range")
        })?,
    )
    .map_err(AppError::from)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub id: String,
    pub login: String,
    pub name: String,
    pub avatar_url: String,
    pub role: String,
    pub created_at: Millis,
    pub username: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteInfo {
    pub name: String,
    pub initialized: bool,
    pub registration_open: bool,
    pub r2_enabled: bool,
    pub kv_enabled: bool,
    pub attachment_storage: Option<String>,
    pub realtime_enabled: bool,
    pub version: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub user: Option<PublicUser>,
    pub site: SiteInfo,
    pub settings: Option<note_core::UserSettings>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpChallenge {
    pub two_factor_required: bool,
    pub challenge_token: String,
    pub expires_at: Millis,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PasswordLoginResult {
    Session(Box<SessionInfo>),
    Challenge(TotpChallenge),
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpLoginResult {
    #[serde(flatten)]
    pub session: SessionInfo,
    pub recovery_code_used: bool,
    pub recovery_codes_remaining: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPage {
    pub files: Vec<AttachmentWithUsage>,
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_ids_cannot_escape_origin() -> Result<(), Box<dyn std::error::Error>> {
        assert!(super::remote_client::entity_path("notes", "../../api/auth/logout").is_err());
        assert!(super::remote_client::entity_path("files", "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_ok());
        let origin = SiteOrigin::parse("https://example.com")?;
        assert!(
            origin
                .check_target(&url::Url::parse("https://example.com:8443/api/notes")?)
                .is_err()
        );
        Ok(())
    }
}
