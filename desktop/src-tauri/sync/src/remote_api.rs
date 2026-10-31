use super::*;

impl RemoteClient {
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
        if matches!(&result,
            PasswordLoginResult::Challenge(challenge)
                if !challenge.two_factor_required || challenge.challenge_token.is_empty()
        )
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
}
