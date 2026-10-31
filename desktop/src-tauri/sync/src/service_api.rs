use super::*;

impl SyncService {
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
    pub(super) fn protected_cookie(&self, client: &RemoteClient) -> Result<SyncCookie, AppError> {
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
}
