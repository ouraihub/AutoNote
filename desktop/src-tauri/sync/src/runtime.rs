use super::*;

impl SyncService {
    /// Returns the current synchronization status.
    ///
    /// # Errors
    /// Returns a local read error.
    pub async fn status(&self) -> Result<SyncStatus, AppError> {
        let state = blocking(&self.library, Library::sync_binding).await?;
        let pending = blocking(&self.library, Library::sync_pending).await?;
        let running = self.runtime.lock().await.is_some();
        Ok(SyncStatus {
            phase: match &state {
                None => "unbound",
                Some(_) if self.syncing.load(Ordering::Acquire) => "syncing",
                Some(_) if running => "idle",
                Some(_) => "paused",
            },
            site_origin: state.as_ref().map(|s| s.binding.site_origin.clone()),
            account: state.as_ref().map(|s| s.binding.account_hint.clone()),
            cursor: state.as_ref().map_or(0, |s| s.cursor),
            pending,
            last_success_at: state.as_ref().and_then(|s| s.last_success_at),
            error_code: state.and_then(|s| s.last_error_code),
        })
    }
    pub(super) async fn publish(&self) -> Result<SyncStatus, AppError> {
        let status = self.status().await?;
        self.sink.changed(&status);
        Ok(status)
    }
    /// Runs one round: pull, then push. The outcome is stored on the binding.
    ///
    /// # Errors
    /// Returns binding, authentication, network, cancellation, attachment or local errors.
    pub async fn now(&self, options: &CallOptions) -> Result<SyncStatus, AppError> {
        self.ensure_running()?;
        let _serial = self.serial.lock().await;
        let options = CallOptions {
            cancel: options.cancel.child_token(),
            deadline: options.deadline,
        };
        *self.active.lock().await = Some(options.cancel.clone());
        self.syncing.store(true, Ordering::Release);
        let _ = self.publish().await;
        let result = self.round(&options).await;
        self.syncing.store(false, Ordering::Release);
        self.active.lock().await.take();
        match &result {
            // A user stop is not a sync failure.
            Err(error) if error.code() == ErrorCode::Cancelled => {}
            outcome => {
                let code = outcome.as_ref().err().map(|e| e.code().as_str().to_owned());
                if let Some(code) = &code {
                    tracing::warn!(code = code.as_str(), "sync.round.failed");
                }
                blocking(&self.library, move |lib| {
                    lib.sync_record_result(code.as_deref())
                })
                .await?;
            }
        }
        let status = self.publish().await?;
        result.map(|()| status)
    }
    async fn round(&self, options: &CallOptions) -> Result<(), AppError> {
        let state = blocking(&self.library, Library::sync_binding)
            .await?
            .ok_or_else(|| error(ErrorCode::BadRequest, "Sync is not bound"))?;
        let remote = self.client(&state)?;
        let session = remote
            .validate_session(options)
            .await
            .map_err(|error| error.app_error())?;
        match session.user {
            None => return Err(error(ErrorCode::Unauthenticated, "Sync session expired")),
            // Never guess that another account is the same person (22 §6.4).
            Some(user) if user.id != state.binding.remote_user_id => {
                return Err(error(
                    ErrorCode::Forbidden,
                    "Remote account changed; unbind first",
                ));
            }
            Some(_) => {}
        }
        let result = async {
            crate::pull::pull(&self.library, &remote, options).await?;
            crate::push::push(&self.library, &remote, options).await
        }
        .await;
        // A renewed cookie is kept even when the round failed later on.
        let cookie = self.protected_cookie(&remote)?;
        blocking(&self.library, move |lib| lib.sync_set_cookie(&cookie)).await?;
        result
    }
    /// Starts the background loop; a running loop is left as is.
    ///
    /// # Errors
    /// Returns a shutdown, binding or local read error.
    pub async fn start(self: &Arc<Self>) -> Result<SyncStatus, AppError> {
        self.ensure_running()?;
        {
            let mut runtime = self.runtime.lock().await;
            if runtime.is_none() {
                if blocking(&self.library, Library::sync_binding)
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
                tokio::spawn(async move { service.run(cancel, id).await });
            }
        }
        self.publish().await
    }
    async fn run(self: Arc<Self>, cancel: CancellationToken, id: String) {
        let mut subscription = None;
        let mut failures: u32 = 0;
        let mut socket_failures: u32 = 0;
        let mut next_socket = Instant::now();
        while !cancel.is_cancelled() {
            let options = CallOptions {
                cancel: cancel.clone(),
                deadline: Instant::now() + Duration::from_secs(120),
            };
            let result = self.now(&options).await;
            if cancel.is_cancelled() {
                break;
            }
            match &result {
                // Credentials or account need the user; retrying cannot help.
                Err(e) if matches!(e.code(), ErrorCode::Unauthenticated | ErrorCode::Forbidden) => {
                    break;
                }
                Err(_) => failures = failures.saturating_add(1),
                Ok(_) => failures = 0,
            }
            let settings = blocking(&self.library, Library::settings_get).await.ok();
            let realtime = settings.as_ref().is_some_and(|s| s.sync.realtime);
            let poll = settings.map_or(15_000, |s| u64::from(s.sync.poll_interval_ms));
            if !realtime {
                subscription = None;
            } else if subscription.is_none() && failures == 0 && Instant::now() >= next_socket {
                let client = blocking(&self.library, Library::sync_binding)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|state| self.client(&state).ok());
                match client {
                    Some(client) => match client.subscribe_changes(&options).await {
                        Ok(socket) => {
                            subscription = Some(socket);
                            socket_failures = 0;
                            // Changes may have landed before the socket opened: pull once more.
                            continue;
                        }
                        Err(_) => {
                            socket_failures = socket_failures.saturating_add(1);
                            next_socket = Instant::now() + backoff(socket_failures);
                        }
                    },
                    None => next_socket = Instant::now() + backoff(1),
                }
            }
            // ponytail: millisecond jitter is enough for one desktop client.
            let jitter = Duration::from_millis(
                remote::now().map_or(0, |now| now.get().unsigned_abs() % 1000),
            );
            let delay = if failures > 0 {
                backoff(failures)
            } else if subscription.is_some() {
                Duration::from_secs(300)
            } else {
                Duration::from_millis(poll)
            } + jitter;
            // The socket's own deadline outlives the sleep, so a quiet socket is never dropped.
            let listen = CallOptions {
                cancel: cancel.clone(),
                deadline: Instant::now() + delay + Duration::from_secs(60),
            };
            tokio::select! {
                () = cancel.cancelled() => break,
                () = self.wake.notified(), if failures == 0 => {
                    // Debounce bursts of local writes into one round.
                    tokio::select! {
                        () = cancel.cancelled() => break,
                        () = tokio::time::sleep(Duration::from_millis(500)) => {}
                    }
                }
                () = tokio::time::sleep(delay) => {}
                message = async {
                    match subscription.as_mut() {
                        Some(socket) => socket.changed(&listen).await,
                        None => std::future::pending().await,
                    }
                } => {
                    if message.is_err() {
                        subscription = None;
                        socket_failures = socket_failures.saturating_add(1);
                        next_socket = Instant::now() + backoff(socket_failures);
                    }
                }
            }
        }
        let mut runtime = self.runtime.lock().await;
        if runtime.as_ref().is_some_and(|runtime| runtime.id == id) {
            runtime.take();
        }
        drop(runtime);
        let _ = self.publish().await;
    }
    /// Stops the background loop and waits for an active round to end.
    ///
    /// # Errors
    /// Returns a local read error.
    pub async fn stop(&self) -> Result<SyncStatus, AppError> {
        if let Some(runtime) = self.runtime.lock().await.take() {
            runtime.cancel.cancel();
        }
        if let Some(active) = self.active.lock().await.take() {
            active.cancel();
        }
        // Wait for the cancelled round to release the engine before reporting.
        drop(self.serial.lock().await);
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
