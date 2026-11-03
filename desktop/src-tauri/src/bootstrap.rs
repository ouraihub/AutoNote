//! Aether host and conversation runtime integration.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use aether_providers::{ModelRef, Store as ProviderStore};
use aether_runtime::conversations::ConversationStore;
use note_core::{Library, NoteId};
use serde::Deserialize;

#[path = "host.rs"]
mod host;
use crate::skill_runner;
const NOTE_MAX_CHARS: usize = 24_000;
const NOTE_TITLE_MAX_CHARS: usize = 200;
const WRITING_FIELD_MAX_BYTES: usize = 24_000;
const WRITING_TOTAL_MAX_BYTES: usize = 80_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WritingRequest {
    action: String,
    note_id: String,
    selected_text: String,
    before_text: String,
    after_text: String,
    cursor_offset: u64,
    language: String,
    title: String,
}

pub(crate) fn validate_writing(
    req: &aether_runtime::RunRequest,
) -> Result<WritingRequest, aether_runtime::KitError> {
    if !req.skills.is_empty() {
        return Err(aether_runtime::KitError::bad_request(
            "skills",
            "writing_not_allowed",
        ));
    }
    if req.permission_mode.unwrap_or_default() != aether_runtime::PermissionMode::Default {
        return Err(aether_runtime::KitError::bad_request(
            "permission_mode",
            "not_allowed",
        ));
    }
    if req.input.len() > WRITING_TOTAL_MAX_BYTES {
        return Err(aether_runtime::KitError::bad_request("input", "too_long"));
    }
    let writing: WritingRequest = serde_json::from_str(&req.input)
        .map_err(|_| aether_runtime::KitError::bad_request("input", "invalid_writing_request"))?;
    let _ = writing.cursor_offset;
    if !matches!(
        writing.action.as_str(),
        "polish" | "rewrite" | "shorten" | "expand" | "continue"
    ) {
        return Err(aether_runtime::KitError::bad_request(
            "action",
            "unsupported",
        ));
    }
    if writing.note_id.is_empty() || writing.note_id.len() > 128 {
        return Err(aether_runtime::KitError::bad_request("noteId", "invalid"));
    }
    if !matches!(writing.language.as_str(), "zh-CN" | "en-US") {
        return Err(aether_runtime::KitError::bad_request(
            "language",
            "unsupported",
        ));
    }
    if writing.cursor_offset > 9_007_199_254_740_991 {
        return Err(aether_runtime::KitError::bad_request(
            "cursorOffset",
            "out_of_range",
        ));
    }
    for (field, value) in [
        ("selectedText", &writing.selected_text),
        ("beforeText", &writing.before_text),
        ("afterText", &writing.after_text),
        ("title", &writing.title),
    ] {
        if value.len() > WRITING_FIELD_MAX_BYTES {
            return Err(aether_runtime::KitError::bad_request(field, "too_long"));
        }
    }
    let expected_scope = format!("note:{}:writing", writing.note_id);
    if req.scope.as_deref() != Some(expected_scope.as_str())
        || req.conversation_id.is_some()
        || req.regenerate
        || req.reply_to_id.is_some()
        || req.retry_turn_id.is_some()
        || req.translate_turn_id.is_some()
        || req.target_language.is_some()
    {
        return Err(aether_runtime::KitError::bad_request(
            "scope",
            "invalid_writing_scope",
        ));
    }
    Ok(writing)
}

fn validate_chat_relation(
    store: &LazyChatStore,
    library: &OnceLock<Arc<Library>>,
    req: &aether_runtime::RunRequest,
) -> Result<(), aether_runtime::KitError> {
    let conversation = req
        .conversation_id
        .as_deref()
        .map(|id| store.get()?.load(id))
        .transpose()?;
    if conversation
        .as_ref()
        .is_some_and(|conversation| conversation.summary.scope.as_deref() != req.scope.as_deref())
    {
        return Err(aether_runtime::KitError::bad_request(
            "scope",
            "conversation_mismatch",
        ));
    }
    let scope = match &conversation {
        Some(conversation) => conversation.summary.scope.as_deref(),
        None => req.scope.as_deref(),
    };
    if let Some(scope) = scope.and_then(|s| s.strip_prefix("note:")) {
        let note_id = scope.strip_suffix(":writing").unwrap_or(scope);
        if req
            .context
            .as_ref()
            .is_some_and(|context| context.kind != "autonote-note" || context.id != note_id)
        {
            return Err(aether_runtime::KitError::bad_request(
                "context",
                "conversation_mismatch",
            ));
        }
        let id = NoteId::new(note_id.to_owned())
            .map_err(|_| aether_runtime::KitError::not_found("note"))?;
        library
            .get()
            .ok_or_else(|| {
                aether_runtime::KitError::internal(std::io::Error::other("library not ready"))
            })?
            .get_note(&id)
            .map_err(|_| aether_runtime::KitError::not_found("note"))?;
    }
    Ok(())
}

pub(crate) struct AetherHost {
    pub(crate) library: Arc<OnceLock<Arc<Library>>>,
    pub(crate) providers: Arc<ProviderStore>,
    pub(crate) chat_store: Arc<LazyChatStore>,
    pub(crate) skills: skill_runner::SkillRunner,
}

pub(crate) struct LazyChatStore {
    pub(crate) root: PathBuf,
    pub(crate) store: Mutex<Option<Arc<aether_runtime::conversations::SqliteStore>>>,
    pub(crate) writing: AtomicU64,
}

impl LazyChatStore {
    fn get(
        &self,
    ) -> Result<Arc<aether_runtime::conversations::SqliteStore>, aether_runtime::KitError> {
        let mut store = self.store.lock().map_err(|_| {
            aether_runtime::KitError::internal(std::io::Error::other("chat store lock poisoned"))
        })?;
        if let Some(store) = &*store {
            return Ok(store.clone());
        }
        let opened = Arc::new(aether_runtime::conversations::SqliteStore::open(
            &self.root,
        )?);
        *store = Some(opened.clone());
        Ok(opened)
    }
}

impl aether_runtime::conversations::ConversationStore for LazyChatStore {
    fn list(
        &self,
        scope: Option<&str>,
        limit: usize,
    ) -> Result<Vec<aether_runtime::conversations::ConversationSummary>, aether_runtime::KitError>
    {
        self.get()?.list(scope, limit)
    }
    fn load(
        &self,
        id: &str,
    ) -> Result<aether_runtime::conversations::Conversation, aether_runtime::KitError> {
        self.get()?.load(id)
    }
    fn reserve_action(
        &self,
        action: &aether_runtime::conversations::ActionRequest,
        validate: &mut dyn FnMut(
            &aether_runtime::conversations::ReservationInput,
        )
            -> Result<aether_chat::RunInput, aether_runtime::KitError>,
    ) -> Result<aether_runtime::conversations::TurnReservation, aether_runtime::KitError> {
        use aether_runtime::conversations::{ResolvedAction, TurnHandle, TurnReservation};
        if action
            .scope
            .as_deref()
            .is_some_and(|scope| scope.ends_with(":writing"))
        {
            if action.conversation_id.is_some()
                || !matches!(action.action, ResolvedAction::Reply { parent_id: None })
                || !action.images.is_empty()
            {
                return Err(aether_runtime::KitError::bad_request(
                    "action",
                    "writing_unsupported",
                ));
            }
            let (_, input) = aether_runtime::conversations::resolve_action(
                None,
                None,
                action.scope.clone(),
                action.input.clone(),
                Vec::new(),
                false,
                None,
                None,
                None,
                None,
            )?;
            let run_input = validate(&input)?;
            let id = self.writing.fetch_add(1, Ordering::Relaxed).to_string();
            return Ok(TurnReservation {
                handle: TurnHandle {
                    conversation_id: format!("writing:{id}"),
                    turn_id: id.clone(),
                    input: input.input.clone(),
                    parent_id: None,
                    question_id: id,
                    supersedes_id: None,
                    kind: "reply".into(),
                },
                input,
                run_input,
            });
        }
        self.get()?.reserve_action(action, validate)
    }
    fn finish_turn(
        &self,
        turn: aether_runtime::conversations::TurnHandle,
        record: aether_runtime::conversations::TurnRecord,
    ) -> Result<(), aether_runtime::KitError> {
        if turn.conversation_id.starts_with("writing:") {
            return Ok(());
        }
        self.get()?.finish_turn(turn, record)
    }
    fn delete(&self, id: &str) -> Result<(), aether_runtime::KitError> {
        self.get()?.delete(id)
    }
    fn rename(
        &self,
        id: &str,
        title: &str,
    ) -> Result<aether_runtime::conversations::ConversationSummary, aether_runtime::KitError> {
        self.get()?.rename(id, title)
    }
    fn edit_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
        text: &str,
        expected_text: &str,
    ) -> Result<aether_runtime::conversations::Conversation, aether_runtime::KitError> {
        self.get()?
            .edit_turn(conversation_id, turn_id, text, expected_text)
    }
    fn remove_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
    ) -> Result<aether_runtime::conversations::Conversation, aether_runtime::KitError> {
        self.get()?.remove_turn(conversation_id, turn_id)
    }
    fn fork(
        &self,
        conversation_id: &str,
        turn_id: &str,
    ) -> Result<aether_runtime::conversations::Conversation, aether_runtime::KitError> {
        self.get()?.fork(conversation_id, turn_id)
    }
    fn select_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
    ) -> Result<aether_runtime::conversations::Conversation, aether_runtime::KitError> {
        self.get()?.select_turn(conversation_id, turn_id)
    }
    fn purge_images(&self, before_ms: i64) -> Result<usize, aether_runtime::KitError> {
        // Maintenance starts before the single-instance guard; never open
        // another process's history.
        let store = self
            .store
            .lock()
            .map_err(|_| {
                aether_runtime::KitError::internal(std::io::Error::other(
                    "chat store lock poisoned",
                ))
            })?
            .clone();
        match store {
            Some(store) => store.purge_images(before_ms),
            None => Ok(0),
        }
    }
    fn add_generated(
        &self,
        turn_id: &str,
        images: &[aether_images::ImagePart],
    ) -> Result<(), aether_runtime::KitError> {
        self.get()?.add_generated(turn_id, images)
    }
}
