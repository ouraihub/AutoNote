//! Existing Worker API, with explicit cookie ownership and no automatic redirects.
#[path = "remote_api.rs"]
mod api;
#[path = "remote_client.rs"]
mod client;
use crate::{SessionCookie, SiteOrigin};
use client::entity_path;
use futures_util::{SinkExt, StreamExt};
use note_core::{
    AppError, Attachment, AttachmentWithUsage, ErrorCode, Folder, Millis, Note, SyncResponse, Tag,
};
use reqwest::{Method, Response};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    future::Future,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

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
            result = tokio::time::timeout_at(self.deadline.into(), future) => result.unwrap_or_else(|_| Err(RemoteError::new(ErrorCode::RequestTimeout))),
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

pub struct RemoteClient {
    origin: SiteOrigin,
    http: reqwest::Client,
    cookie: Mutex<Option<SessionCookie>>,
}

pub struct ChangeSubscription {
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
}
impl ChangeSubscription {
    /// Waits for a change notification or heartbeat response.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, offline, or invalid-response errors.
    pub async fn changed(&mut self, options: &CallOptions) -> Result<bool, RemoteError> {
        options.run(async {
            let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
            let mut pong_deadline = tokio::time::Instant::now() + Duration::from_secs(35);
            loop {
                tokio::select! {
                    _ = heartbeat.tick() => self.socket.send(Message::Text("{\"type\":\"ping\"}".into())).await.map_err(|_| RemoteError::new(ErrorCode::Offline))?,
                    _ = tokio::time::sleep_until(pong_deadline) => return Err(RemoteError::new(ErrorCode::RequestTimeout)),
                    message = self.socket.next() => match message {
                        Some(Ok(Message::Text(text))) => {
                            let value: Value = serde_json::from_str(&text).map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))?;
                            match value.get("type").and_then(Value::as_str) {
                                Some("changed") if value.get("cursor").and_then(Value::as_i64).is_some_and(|cursor| (0..=note_core::MAX_SAFE_INTEGER).contains(&cursor)) => return Ok(true),
                                Some("pong") if value.get("serverTime").and_then(Value::as_i64).is_some_and(|time| (0..=note_core::MAX_SAFE_INTEGER).contains(&time)) => pong_deadline = tokio::time::Instant::now() + Duration::from_secs(35),
                                Some("ping") => self.socket.send(Message::Text(json!({"type":"pong","serverTime":now()?.get()}).to_string().into())).await.map_err(|_| RemoteError::new(ErrorCode::Offline))?,
                                _ => return Err(RemoteError::new(ErrorCode::InvalidResponse)),
                            }
                        },
                        Some(Ok(Message::Ping(bytes))) => self.socket.send(Message::Pong(bytes)).await.map_err(|_| RemoteError::new(ErrorCode::Offline))?,
                        Some(Ok(Message::Pong(_))) => pong_deadline = tokio::time::Instant::now() + Duration::from_secs(35),
                        _ => return Err(RemoteError::new(ErrorCode::Offline)),
                    },
                }
            }
        }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_ids_cannot_escape_origin() -> Result<(), Box<dyn std::error::Error>> {
        assert!(entity_path("notes", "../../api/auth/logout").is_err());
        assert!(entity_path("files", "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_ok());
        let origin = SiteOrigin::parse("https://example.com")?;
        assert!(
            origin
                .check_target(&url::Url::parse("https://example.com:8443/api/notes")?)
                .is_err()
        );
        Ok(())
    }
}
