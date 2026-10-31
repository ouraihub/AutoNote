use super::*;

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
    pub(super) fn cookie_header(&self, target: &url::Url) -> Result<Option<String>, RemoteError> {
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
    pub(super) async fn send(
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
    pub(super) async fn bytes(
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
    pub(super) async fn json<T: DeserializeOwned>(
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
pub(super) fn entity_path(entity: &str, id: &str) -> Result<String, RemoteError> {
    if id.len() != 26 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(RemoteError::new(ErrorCode::BadRequest));
    }
    Ok(format!("/api/{entity}/{id}"))
}
