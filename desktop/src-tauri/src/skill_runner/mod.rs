//! Executes only packaged scripts from the immutable selection of one interactive run.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aether_runtime::{Approval, HostTool, RunRequest, ToolCall, ToolError};
#[cfg(test)]
use aether_runtime::{AuthorizeContext, CancellationToken, PermissionMode, ToolEffect, ToolSource};
use serde::Deserialize;
#[cfg(test)]
use serde_json::json;
#[cfg(test)]
use std::fs;
mod cleanup;
mod output;
mod process;
mod snapshot;
mod validation;
pub(super) use cleanup::materialize;
pub(super) use validation::{arguments, safe_relative, selected};
const DEFAULT_TIMEOUT: u64 = 120;
const MAX_TIMEOUT: u64 = 1800;
const EXECUTION_NOTICE: &str = "NOT A SANDBOX: runs as your user; can access files and network.";

pub(super) struct SkillRunner {
    store: Arc<aether_skills::Store>,
    root: PathBuf,
    runs: Mutex<HashMap<String, Selection>>,
}

pub(super) struct Selection {
    token: String,
    skills: Vec<Arc<Snapshot>>,
    calls: HashMap<String, serde_json::Value>,
    used: HashSet<String>,
}

pub(super) struct Snapshot {
    id: String,
    revision: u32,
    files: Vec<(String, Vec<u8>)>,
    scripts: Vec<String>,
    risky: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Arguments {
    #[serde(rename = "_executionNotice")]
    execution_notice: String,
    snapshot: String,
    skill_id: String,
    revision: u32,
    path: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default = "default_timeout")]
    timeout_seconds: u64,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT
}

fn risk_language(
    language: crate::skill_process::ScriptLanguage,
) -> aether_chat::risk::ScriptLanguage {
    match language {
        crate::skill_process::ScriptLanguage::Shell => aether_chat::risk::ScriptLanguage::Shell,
        crate::skill_process::ScriptLanguage::PowerShell => {
            aether_chat::risk::ScriptLanguage::PowerShell
        }
        crate::skill_process::ScriptLanguage::Python => aether_chat::risk::ScriptLanguage::Python,
        crate::skill_process::ScriptLanguage::JavaScript => {
            aether_chat::risk::ScriptLanguage::JavaScript
        }
    }
}

fn selection_choices(snapshots: &[Arc<Snapshot>]) -> Vec<serde_json::Value> {
    snapshots
        .iter()
        .flat_map(|skill| {
            skill.scripts.iter().map(move |path| {
                serde_json::json!({
                    "properties": {
                        "skillId": {"enum": [skill.id]},
                        "revision": {"enum": [skill.revision]},
                        "path": {"enum": [path]}
                    }
                })
            })
        })
        .collect()
}

fn failure(code: &str, message: impl ToString, unknown: bool) -> ToolError {
    ToolError {
        code: code.into(),
        message: message.to_string(),
        unknown,
    }
}

impl SkillRunner {
    pub(super) fn new(store: Arc<aether_skills::Store>, root: PathBuf) -> Self {
        Self {
            store,
            root,
            runs: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn tools(&self, req: &RunRequest, run_id: &str) -> Vec<HostTool> {
        snapshot::tools(self, req, run_id)
    }

    pub(super) fn finish(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
    }

    pub(super) fn authorize(
        &self,
        call: &ToolCall,
        ctx: &aether_runtime::AuthorizeContext<'_>,
    ) -> Approval {
        validation::authorize(self, call, ctx)
    }

    pub(super) async fn execute(
        &self,
        call: &ToolCall,
        cancel: &aether_runtime::CancellationToken,
    ) -> Result<aether_runtime::ToolOutput, ToolError> {
        process::execute(self, call, cancel).await
    }
}

#[cfg(test)]
#[path = "../skill_runner_tests.rs"]
mod tests;
