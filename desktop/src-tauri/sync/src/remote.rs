//! Existing Worker API, with explicit cookie ownership and no automatic redirects.
use crate::{SessionCookie, SiteOrigin};
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
impl RemoteClient {
    /// Builds an HTTP client for the configured origin.
    ///
    /// # Errors
    /// Returns an error when the HTTP client cannot be constructed.
    pub fn new(origin: SiteOrigin, cookie: Option<SessionCookie>) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| AppError::new(ErrorCode::Internal, "HTTP client unavailable"))?;
        Ok(Self {
            origin,
            http,
            cookie: Mutex::new(cookie),
        })
    }
    pub fn origin(&self) -> &SiteOrigin {
        &self.origin
    }
    /// Returns the current session cookie record, if any.
    ///
    /// # Errors
    /// Returns an error when session state is unavailable or cannot be serialized.
    pub fn cookie_record(&self) -> Result<Option<crate::session::CookieRecord>, AppError> {
        self.cookie
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "Session unavailable"))?
            .as_ref()
            .map(SessionCookie::record)
            .transpose()
    }
    fn cookie_header(&self, target: &url::Url) -> Result<Option<String>, RemoteError> {
        let mut guard = self
            .cookie
            .lock()
            .map_err(|_| RemoteError::new(ErrorCode::Internal))?;
        let now = now()?;
        if guard.as_ref().is_some_and(|cookie| cookie.is_expired(now)) {
            guard.take();
        }
        guard
            .as_ref()
            .map(|cookie| cookie.request_header(target, now))
            .transpose()
            .map(|value| value.flatten())
            .map_err(RemoteError::from)
    }
    async fn send(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
        form: Option<reqwest::multipart::Form>,
        options: &CallOptions,
    ) -> Result<Response, RemoteError> {
        options
            .run(async {
                let mut target = self
                    .origin
                    .as_url()
                    .join(path)
                    .map_err(|_| RemoteError::new(ErrorCode::BadRequest))?;
                self.origin.check_target(&target)?;
                target
                    .query_pairs_mut()
                    .extend_pairs(query.iter().map(|(key, value)| (*key, value.as_str())));
                let mut request = self
                    .http
                    .request(method.clone(), target.clone())
                    .header("X-AutoNote-Client", "1")
                    .header(
                        "Origin",
                        self.origin.as_url().origin().ascii_serialization(),
                    )
                    .header("Accept", "application/json");
                if let Some(header) = self.cookie_header(&target)? {
                    request = request.header(reqwest::header::COOKIE, header);
                }
                if let Some(value) = body {
                    request = request.json(&value);
                }
                if let Some(value) = form {
                    request = request.multipart(value);
                }
                let mut response = request.send().await.map_err(network)?;
                for attempt in 0..=5 {
                    self.origin.check_target(response.url())?;
                    for header in response.headers().get_all(reqwest::header::SET_COOKIE) {
                        let cookie = SessionCookie::parse(
                            &self.origin,
                            response.url(),
                            header
                                .to_str()
                                .map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))?,
                            now()?,
                        )?;
                        *self
                            .cookie
                            .lock()
                            .map_err(|_| RemoteError::new(ErrorCode::Internal))? =
                            if cookie.is_expired(now()?) {
                                None
                            } else {
                                Some(cookie)
                            };
                    }
                    if !response.status().is_redirection() {
                        return Ok(response);
                    }
                    let location = response
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .ok_or_else(|| RemoteError::new(ErrorCode::InvalidResponse))?;
                    target = response
                        .url()
                        .join(location)
                        .map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))?;
                    self.origin.check_target(&target)?;
                    // Never replay a write body, Cookie or Authorization on a redirect.
                    if method != Method::GET || attempt == 5 {
                        return Err(RemoteError::new(ErrorCode::InvalidResponse));
                    }
                    response = self
                        .http
                        .get(target.clone())
                        .header("X-AutoNote-Client", "1")
                        .send()
                        .await
                        .map_err(network)?;
                }
                Err(RemoteError::new(ErrorCode::InvalidResponse))
            })
            .await
    }
    async fn bytes(
        &self,
        response: Response,
        limit: usize,
        options: &CallOptions,
    ) -> Result<Vec<u8>, RemoteError> {
        options
            .run(async {
                if response
                    .content_length()
                    .is_some_and(|size| size > limit as u64)
                {
                    return Err(RemoteError::new(ErrorCode::PayloadTooLarge));
                }
                let mut bytes = Vec::new();
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(network)?;
                    if chunk.len() > limit.saturating_sub(bytes.len()) {
                        return Err(RemoteError::new(ErrorCode::PayloadTooLarge));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(bytes)
            })
            .await
    }
    async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
        options: &CallOptions,
    ) -> Result<T, RemoteError> {
        let response = self.send(method, path, query, body, None, options).await?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        let bytes = self.bytes(response, JSON_MAX_BYTES, options).await?;
        if !status.is_success() {
            let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let code = match status.as_u16() {
                400 => ErrorCode::BadRequest,
                401 => ErrorCode::Unauthenticated,
                403 => ErrorCode::Forbidden,
                404 => ErrorCode::NotFound,
                409 => ErrorCode::Conflict,
                413 => ErrorCode::PayloadTooLarge,
                429 => ErrorCode::TooManyAttempts,
                503 => ErrorCode::StorageUnavailable,
                _ => ErrorCode::Internal,
            };
            // The Worker wraps every failure as `{ error: { code, message, details } }`.
            return Err(RemoteError {
                code,
                server: value
                    .pointer("/error/details/server")
                    .and_then(|server| serde_json::from_value(server.clone()).ok()),
                retry_after: retry_after.or_else(|| {
                    value
                        .pointer("/error/details/retryAfter")
                        .and_then(Value::as_u64)
                }),
            });
        }
        serde_json::from_slice(&bytes).map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))
    }
    /// Authenticates with the remote password endpoint.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn login(
        &self,
        username: &str,
        password: &str,
        options: &CallOptions,
    ) -> Result<PasswordLoginResult, RemoteError> {
        let result: PasswordLoginResult = self
            .json(
                Method::POST,
                "/api/auth/login",
                &[],
                Some(json!({"username":username,"password":password})),
                options,
            )
            .await?;
        if matches!(&result, PasswordLoginResult::Challenge(challenge) if !challenge.two_factor_required || challenge.challenge_token.is_empty())
        {
            return Err(RemoteError::new(ErrorCode::InvalidResponse));
        }
        Ok(result)
    }
    /// Completes a two-factor login challenge.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn complete_totp(
        &self,
        challenge: &str,
        code: &str,
        options: &CallOptions,
    ) -> Result<TotpLoginResult, RemoteError> {
        self.json(
            Method::POST,
            "/api/auth/totp/login",
            &[],
            Some(json!({"challengeToken":challenge,"code":code})),
            options,
        )
        .await
    }
    /// Validates the current remote session.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn validate_session(
        &self,
        options: &CallOptions,
    ) -> Result<SessionInfo, RemoteError> {
        self.json(Method::GET, "/api/auth/session", &[], None, options)
            .await
    }
    /// Fetches a validated synchronization page.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn sync_page(
        &self,
        since: i64,
        after: Option<&str>,
        snapshot: Option<i64>,
        options: &CallOptions,
    ) -> Result<SyncResponse, RemoteError> {
        if !(0..=note_core::MAX_SAFE_INTEGER).contains(&since) {
            return Err(RemoteError::new(ErrorCode::BadRequest));
        }
        let mut query = vec![("since", since.to_string())];
        if let Some(key) = after {
            query.push(("after", key.to_owned()));
        }
        if let Some(cursor) = snapshot {
            query.push(("snapshot", cursor.to_string()));
        }
        let page: SyncResponse = self
            .json(Method::GET, "/api/sync", &query, None, options)
            .await?;
        if page.has_more && page.full && page.next_key.as_ref().is_none_or(String::is_empty)
            || !page.full
                && (page.cursor.get() < since || page.has_more && page.cursor.get() <= since)
        {
            return Err(RemoteError::new(ErrorCode::InvalidResponse));
        }
        Ok(page)
    }
    /// Fetches one note by ID.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn get_note(&self, id: &str, options: &CallOptions) -> Result<Note, RemoteError> {
        self.json(Method::GET, &entity_path("notes", id)?, &[], None, options)
            .await
    }
    /// Creates a note remotely.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn create_note(
        &self,
        input: Value,
        options: &CallOptions,
    ) -> Result<Note, RemoteError> {
        self.json(Method::POST, "/api/notes", &[], Some(input), options)
            .await
    }
    /// Updates a note remotely.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn patch_note(
        &self,
        id: &str,
        input: Value,
        options: &CallOptions,
    ) -> Result<Note, RemoteError> {
        self.json(
            Method::PATCH,
            &entity_path("notes", id)?,
            &[],
            Some(input),
            options,
        )
        .await
    }
    /// Moves a note to trash remotely.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn trash_note(&self, id: &str, options: &CallOptions) -> Result<Note, RemoteError> {
        self.json(
            Method::DELETE,
            &entity_path("notes", id)?,
            &[],
            None,
            options,
        )
        .await
    }
    /// Restores a note remotely.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn restore_note(
        &self,
        id: &str,
        input: Value,
        options: &CallOptions,
    ) -> Result<Note, RemoteError> {
        self.json(
            Method::POST,
            &format!("{}/restore", entity_path("notes", id)?),
            &[],
            Some(input),
            options,
        )
        .await
    }
    /// Permanently removes a note remotely.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn purge_note(&self, id: &str, options: &CallOptions) -> Result<Value, RemoteError> {
        self.json(
            Method::DELETE,
            &format!("{}/purge", entity_path("notes", id)?),
            &[],
            None,
            options,
        )
        .await
    }
    /// Lists remote folders.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn list_folders(&self, options: &CallOptions) -> Result<Vec<Folder>, RemoteError> {
        #[derive(Deserialize)]
        struct Folders {
            folders: Vec<Folder>,
        }
        Ok(self
            .json::<Folders>(Method::GET, "/api/folders", &[], None, options)
            .await?
            .folders)
    }
    /// Lists remote tags.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn list_tags(&self, options: &CallOptions) -> Result<Vec<Tag>, RemoteError> {
        #[derive(Deserialize)]
        struct Tags {
            tags: Vec<Tag>,
        }
        Ok(self
            .json::<Tags>(Method::GET, "/api/tags", &[], None, options)
            .await?
            .tags)
    }
    /// Writes a remote folder or tag.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn metadata_write(
        &self,
        entity: &str,
        id: Option<&str>,
        method: Method,
        input: Option<Value>,
        options: &CallOptions,
    ) -> Result<Value, RemoteError> {
        if !matches!(entity, "folders" | "tags") {
            return Err(RemoteError::new(ErrorCode::BadRequest));
        }
        let path = id.map_or_else(
            || Ok(format!("/api/{entity}")),
            |id| entity_path(entity, id),
        )?;
        let query = if entity == "folders" && method == Method::DELETE {
            vec![("strategy", "move-up".to_owned())]
        } else {
            vec![]
        };
        self.json(method, &path, &query, input, options).await
    }
    /// Lists remote attachment metadata.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn list_attachments(
        &self,
        cursor: Option<&str>,
        options: &CallOptions,
    ) -> Result<AttachmentPage, RemoteError> {
        let query = cursor
            .map(|cursor| vec![("cursor", cursor.to_owned())])
            .unwrap_or_default();
        self.json(Method::GET, "/api/files", &query, None, options)
            .await
    }
    /// Uploads one attachment.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn upload_file(
        &self,
        filename: &str,
        mime: &str,
        bytes: Vec<u8>,
        note_id: Option<&str>,
        options: &CallOptions,
    ) -> Result<Attachment, RemoteError> {
        if bytes.len() > ATTACHMENT_MAX_BYTES {
            return Err(RemoteError::new(ErrorCode::PayloadTooLarge));
        }
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.to_owned())
            .mime_str(mime)
            .map_err(|_| RemoteError::new(ErrorCode::BadRequest))?;
        let mut form = reqwest::multipart::Form::new().part("file", part);
        if let Some(id) = note_id {
            form = form.text("noteId", id.to_owned());
        }
        let response = self
            .send(Method::POST, "/api/files", &[], None, Some(form), options)
            .await?;
        let status = response.status();
        let bytes = self.bytes(response, JSON_MAX_BYTES, options).await?;
        if !status.is_success() {
            return Err(RemoteError::new(match status.as_u16() {
                401 => ErrorCode::Unauthenticated,
                429 => ErrorCode::TooManyAttempts,
                413 => ErrorCode::PayloadTooLarge,
                _ => ErrorCode::BadRequest,
            }));
        }
        serde_json::from_slice(&bytes).map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))
    }
    /// Removes one remote attachment.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn remove_file(&self, id: &str, options: &CallOptions) -> Result<Value, RemoteError> {
        self.json(
            Method::DELETE,
            &entity_path("files", id)?,
            &[],
            None,
            options,
        )
        .await
    }
    /// Downloads one remote attachment.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, or invalid-response errors.
    pub async fn download_file(
        &self,
        id: &str,
        options: &CallOptions,
    ) -> Result<Vec<u8>, RemoteError> {
        let response = self
            .send(
                Method::GET,
                &entity_path("files", id)?,
                &[],
                None,
                None,
                options,
            )
            .await?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(RemoteError::new(if response.status().as_u16() == 404 {
                ErrorCode::NotFound
            } else if response.status().as_u16() == 401 {
                ErrorCode::Unauthenticated
            } else {
                ErrorCode::InvalidResponse
            }));
        }
        self.bytes(response, ATTACHMENT_MAX_BYTES, options).await
    }
    /// Opens the remote change notification stream.
    ///
    /// # Errors
    /// Returns remote, cancellation, timeout, authentication, or invalid-response errors.
    pub async fn subscribe_changes(
        &self,
        options: &CallOptions,
    ) -> Result<ChangeSubscription, RemoteError> {
        options
            .run(async {
                let target = self
                    .origin
                    .as_url()
                    .join("/api/sync/ws")
                    .map_err(|_| RemoteError::new(ErrorCode::BadRequest))?;
                let cookie = self
                    .cookie_header(&target)?
                    .ok_or_else(|| RemoteError::new(ErrorCode::Unauthenticated))?;
                let mut ws = target.clone();
                ws.set_scheme(if target.scheme() == "https" {
                    "wss"
                } else {
                    "ws"
                })
                .map_err(|_| RemoteError::new(ErrorCode::BadRequest))?;
                let mut request = ws
                    .as_str()
                    .into_client_request()
                    .map_err(|_| RemoteError::new(ErrorCode::BadRequest))?;
                request.headers_mut().insert(
                    "Cookie",
                    cookie
                        .parse()
                        .map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))?,
                );
                request.headers_mut().insert(
                    "Origin",
                    self.origin
                        .as_url()
                        .origin()
                        .ascii_serialization()
                        .parse()
                        .map_err(|_| RemoteError::new(ErrorCode::InvalidResponse))?,
                );
                let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                    .max_message_size(Some(4096))
                    .max_frame_size(Some(4096));
                let (socket, _) =
                    tokio_tungstenite::connect_async_with_config(request, Some(config), false)
                        .await
                        .map_err(|_| RemoteError::new(ErrorCode::Offline))?;
                Ok(ChangeSubscription { socket })
            })
            .await
    }
}
fn entity_path(entity: &str, id: &str) -> Result<String, RemoteError> {
    if id.len() != 26 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(RemoteError::new(ErrorCode::BadRequest));
    }
    Ok(format!("/api/{entity}/{id}"))
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
