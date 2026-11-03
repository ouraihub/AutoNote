//! Application shell: opens the library, registers commands, starts the window.
//!
//! No business logic lives here; commands forward to `note-core`.

mod bootstrap;
mod commands;
mod events;
mod protocol;
mod runtime;
mod shortcut;
mod skill_process;
mod skill_runner;
mod state;
mod tray;
mod window;

#[cfg(test)]
mod chat_context_tests;
#[cfg(test)]
use aether_providers::{ModelRef, Store as ProviderStore};
#[cfg(test)]
use aether_runtime::conversations::ConversationStore;
#[cfg(test)]
use bootstrap::{AetherHost, LazyChatStore, validate_writing};
#[cfg(test)]
use note_core::{Library, NoteId};
pub(crate) use state::AppContext;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::sync::{Arc, Mutex, OnceLock};

pub fn run() {
    runtime::run();
}
