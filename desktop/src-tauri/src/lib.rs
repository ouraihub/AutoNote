//! Application shell: opens the library, registers commands, starts the window.
//!
//! No business logic lives here; commands forward to `note-core`.

mod commands;
mod events;
mod application;
mod startup;
mod host;
mod shortcut;
mod skill_process;
mod skill_runner;
mod tray;
mod window;

#[cfg(test)]
mod chat_context_tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use host::{AetherHost, LazyChatStore};
use aether_observability::LogConfig;
use aether_providers::{ModelRef, Store as ProviderStore};
use aether_runtime::conversations::ConversationStore;
use note_core::{AppError, Error, ErrorCode, Library, LibraryDeps, NoteId, RandomIds, SystemClock};
use serde::Deserialize;
use tauri::Manager;

const NOTE_MAX_CHARS: usize = 24_000;
const NOTE_TITLE_MAX_CHARS: usize = 200;
const WRITING_FIELD_MAX_BYTES: usize = 24_000;
const WRITING_TOTAL_MAX_BYTES: usize = 80_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WritingRequest {
    action: String,
    note_id: String,
    selected_text: String,
    before_text: String,
    after_text: String,
    cursor_offset: u64,
    language: String,
    title: String,
}

fn validate_writing(
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

/// Cancel flags for running Channel-reporting commands, keyed by caller jobId.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Jobs {
    /// Registers `job_id`; a duplicate id is `bad_request` so progress never mixes.
    ///
    /// # Errors
    /// `bad_request` for an empty, oversized or already-running id.
    pub fn start(&self, job_id: &str) -> Result<Arc<AtomicBool>, AppError> {
        if job_id.is_empty() || job_id.len() > 128 {
            return Err(AppError::new(
                ErrorCode::BadRequest,
                "jobId must be 1 to 128 characters",
            ));
        }
        let mut jobs = self.0.lock().map_err(|_| AppError::from(Error::Poisoned))?;
        if jobs.contains_key(job_id) {
            return Err(AppError::new(
                ErrorCode::BadRequest,
                "jobId is already running",
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        jobs.insert(job_id.to_owned(), flag.clone());
        Ok(flag)
    }
    pub fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.0.lock() {
            jobs.remove(job_id);
        }
    }
    /// `true` when a running job took the cancel; repeated cancels stay `true`.
    pub fn cancel(&self, job_id: &str) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).cloned())
            .is_some_and(|flag| {
                flag.store(true, Ordering::Relaxed);
                true
            })
    }
}

#[derive(Clone)]
pub struct AppContext {
    pub data_dir: PathBuf,
    pub library: Arc<Library>,
    pub jobs: Arc<Jobs>,
    pub sync: Arc<note_sync::SyncService>,
    pub logs: aether_observability::LogHandle,
    pub providers: Arc<ProviderStore>,
}

pub fn run() {
    startup::run();
}
