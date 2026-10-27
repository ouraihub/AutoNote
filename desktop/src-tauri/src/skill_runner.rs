//! Executes only packaged scripts from the immutable selection of one interactive run.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::skill_process;
use aether_chat::risk::{ScriptLanguage, script_risk};
use serde::Deserialize;
use serde_json::json;
use tauri_plugin_aether::{
    Approval, AuthorizeContext, CancellationToken, HostTool, PermissionMode, RunRequest, ToolCall,
    ToolEffect, ToolError, ToolOutput, ToolSource, ToolSpec,
};

const DEFAULT_TIMEOUT: u64 = 120;
const MAX_TIMEOUT: u64 = 1800;
const EXECUTION_NOTICE: &str = "NOT A SANDBOX: runs as your user; can access files and network.";

fn risk_language(language: skill_process::ScriptLanguage) -> ScriptLanguage {
    match language {
        skill_process::ScriptLanguage::Shell => ScriptLanguage::Shell,
        skill_process::ScriptLanguage::PowerShell => ScriptLanguage::PowerShell,
        skill_process::ScriptLanguage::Python => ScriptLanguage::Python,
        skill_process::ScriptLanguage::JavaScript => ScriptLanguage::JavaScript,
    }
}

pub(super) struct SkillRunner {
    store: aether_skills::Store,
    root: PathBuf,
    runs: Mutex<HashMap<String, Selection>>,
}

struct Selection {
    token: String,
    skills: Vec<Arc<Snapshot>>,
    calls: HashMap<String, serde_json::Value>,
    used: HashSet<String>,
}

struct Snapshot {
    id: String,
    revision: u32,
    files: Vec<(String, Vec<u8>)>,
    scripts: Vec<String>,
    risky: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arguments {
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

fn failure(code: &str, message: impl ToString, unknown: bool) -> ToolError {
    ToolError {
        code: code.into(),
        message: message.to_string(),
        unknown,
    }
}

impl SkillRunner {
    pub(super) fn new(store: aether_skills::Store, root: PathBuf) -> Self {
        Self {
            store,
            root,
            runs: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn tools(&self, req: &RunRequest, run_id: &str) -> Vec<HostTool> {
        if req.purpose != "chat" || req.permission_mode == Some(PermissionMode::Plan) {
            return Vec::new();
        }
        let mut snapshots = Vec::new();
        for selected in &req.skills {
            let Ok(files) = self.store.files(&selected.id, selected.revision) else {
                return Vec::new();
            };
            let mut snapshot = Snapshot {
                id: selected.id.clone(),
                revision: selected.revision,
                files: Vec::new(),
                scripts: Vec::new(),
                risky: false,
            };
            for file in files {
                if !safe_relative(&file.path) {
                    return Vec::new();
                }
                let Ok(content) = self.store.file(&selected.id, selected.revision, &file.path)
                else {
                    return Vec::new();
                };
                if file.kind == aether_skills::SkillFileKind::Script {
                    if let Some((language, _, _)) = skill_process::interpreter(&file.path) {
                        snapshot.scripts.push(file.path.clone());
                        snapshot.risky |= std::str::from_utf8(&content).map_or(true, |source| {
                            script_risk(risk_language(language), source).is_some()
                        });
                    } else {
                        snapshot.risky = true;
                    }
                }
                snapshot.files.push((file.path, content));
            }
            // A final revision check also rejects a replacement between individual reads.
            if self.store.files(&selected.id, selected.revision).is_err() {
                return Vec::new();
            }
            if !snapshot.scripts.is_empty() {
                snapshots.push(Arc::new(snapshot));
            }
        }
        if snapshots.is_empty() {
            return Vec::new();
        }
        let token = uuid::Uuid::new_v4().to_string();
        let choices: Vec<_> = snapshots.iter().flat_map(|skill| skill.scripts.iter().map(move |path| {
            json!({"properties":{"skillId":{"enum":[skill.id]},"revision":{"enum":[skill.revision]},"path":{"enum":[path]}}})
        })).collect();
        let Ok(mut runs) = self.runs.lock() else {
            return Vec::new();
        };
        runs.insert(
            run_id.into(),
            Selection {
                token: token.clone(),
                skills: snapshots,
                calls: HashMap::new(),
                used: HashSet::new(),
            },
        );
        vec![HostTool { spec: ToolSpec {
            name: "skill_run".into(),
            description: "Run only a packaged script from this run's selected immutable skill revision. NOT a sandbox: executes as the current user with filesystem and network access. Approval binds the displayed revision, script, arguments and timeout. Omit timeoutSeconds to use 120 seconds.".into(),
            parameters: json!({"type":"object", "additionalProperties":false,
                "required":["_executionNotice","snapshot","skillId","revision","path","args"],
                "oneOf": choices,
                "properties": {
                    "_executionNotice":{"type":"string","enum":[EXECUTION_NOTICE]},
                    "snapshot":{"type":"string","enum":[token]},
                    "skillId":{"type":"string"}, "revision":{"type":"integer"},
                    "path":{"type":"string"},
                    "args":{"type":"array","items":{"type":"string"},"maxItems":128},
                    "timeoutSeconds":{"type":"integer","minimum":1,"maximum":MAX_TIMEOUT,"default":DEFAULT_TIMEOUT}
                }}),
            approval: Approval::Ask, source: ToolSource::Host, effect: ToolEffect::Exec,
        }}]
    }

    pub(super) fn finish(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
    }

    pub(super) fn authorize(&self, call: &ToolCall, ctx: &AuthorizeContext<'_>) -> Approval {
        if call.name != "skill_run" {
            return ctx.proposed;
        }
        if ctx.purpose != "chat"
            || ctx.mode == PermissionMode::Plan
            || !matches!(ctx.source, ToolSource::Host)
        {
            return Approval::Deny;
        }
        let Ok(args) = arguments(call) else {
            return Approval::Deny;
        };
        let Ok(mut runs) = self.runs.lock() else {
            return Approval::Deny;
        };
        let Some(run) = runs.get_mut(ctx.run_id) else {
            return Approval::Deny;
        };
        let Some(snapshot) = selected(run, &args) else {
            return Approval::Deny;
        };
        if run.used.contains(&call.id) || run.calls.contains_key(&call.id) {
            return Approval::Deny;
        }
        let risky = snapshot.risky;
        run.calls.insert(call.id.clone(), call.args.clone());
        match ctx.mode {
            PermissionMode::FullAccess => Approval::Auto,
            PermissionMode::Auto if !risky => Approval::Auto,
            _ => Approval::Ask,
        }
    }

    pub(super) async fn execute(
        &self,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput, ToolError> {
        if call.name != "skill_run" {
            return Err(ToolError::not_found());
        }
        let args = arguments(call)?;
        let snapshot = {
            let mut runs = self
                .runs
                .lock()
                .map_err(|_| failure("internal", "skill run lock unavailable", false))?;
            let run = runs
                .values_mut()
                .find(|run| run.token == args.snapshot)
                .ok_or_else(|| failure("not_allowed", "skill snapshot is not active", false))?;
            if run.calls.get(&call.id) != Some(&call.args) || !run.used.insert(call.id.clone()) {
                return Err(failure(
                    "not_allowed",
                    "script arguments were not authorized",
                    false,
                ));
            }
            run.calls.remove(&call.id);
            selected(run, &args).cloned().ok_or_else(|| {
                failure(
                    "not_allowed",
                    "script is outside this run's selection",
                    false,
                )
            })?
        };
        if cancel.is_cancelled() {
            return Err(failure(
                "cancelled",
                "script cancelled before launch",
                false,
            ));
        }
        let root = self.root.clone();
        let workspace = tokio::task::spawn_blocking(move || materialize(&root, &snapshot))
            .await
            .map_err(|error| failure("internal", error, false))??;
        let payload = skill_process::run_script(
            &workspace.0,
            &skill_process::Arguments {
                path: args.path,
                args: args.args,
                timeout_seconds: args.timeout_seconds,
            },
            cancel,
        )
        .await
        .map_err(|error| ToolError {
            code: error.code,
            message: error.message,
            unknown: error.unknown,
        })?;
        Ok(ToolOutput {
            text: payload.to_string(),
            payload: Some(payload),
        })
    }
}

fn arguments(call: &ToolCall) -> Result<Arguments, ToolError> {
    let args: Arguments = serde_json::from_value(call.args.clone())
        .map_err(|_| failure("bad_request", "invalid script arguments", false))?;
    if args.execution_notice != EXECUTION_NOTICE || call.args.to_string().chars().count() > 2000 {
        return Err(failure(
            "bad_request",
            "execution notice and complete approval preview are required",
            false,
        ));
    }
    if args.timeout_seconds == 0
        || args.timeout_seconds > MAX_TIMEOUT
        || args.args.len() > 128
        || args
            .args
            .iter()
            .any(|arg| arg.len() > 8192 || arg.contains('\0'))
        || !safe_relative(&args.path)
    {
        return Err(failure("bad_request", "invalid script arguments", false));
    }
    Ok(args)
}

fn selected<'a>(run: &'a Selection, args: &Arguments) -> Option<&'a Arc<Snapshot>> {
    if run.token != args.snapshot {
        return None;
    }
    run.skills.iter().find(|skill| {
        skill.id == args.skill_id
            && skill.revision == args.revision
            && skill.scripts.contains(&args.path)
    })
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':', '\0'])
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !reserved_name(part)
        })
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn reserved_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

struct Workspace(PathBuf);
impl Drop for Workspace {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            tracing::warn!(error = %error, "skill.run.cleanup_failed");
        }
    }
}

fn directory(path: &Path) -> std::io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    let link = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let link = metadata.file_type().is_symlink();
    if !metadata.is_dir() || link {
        return Err(std::io::Error::other("linked staging directory rejected"));
    }
    Ok(())
}

fn materialize(root: &Path, snapshot: &Snapshot) -> Result<Workspace, ToolError> {
    let write = || -> std::io::Result<Workspace> {
        let root = fs::canonicalize(root)?;
        let staging = root.join("staging");
        directory(&staging)?;
        let staging = staging.join("skill-runs");
        directory(&staging)?;
        let path = staging.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&path)?;
        let workspace = Workspace(path);
        for (relative, content) in &snapshot.files {
            if !safe_relative(relative) {
                return Err(std::io::Error::other("invalid packaged file path"));
            }
            let target = workspace.0.join(relative);
            let parent = target
                .parent()
                .ok_or_else(|| std::io::Error::other("file parent missing"))?;
            let mut current = workspace.0.clone();
            for component in parent
                .strip_prefix(&workspace.0)
                .map_err(std::io::Error::other)?
                .components()
            {
                current.push(component);
                directory(&current)?;
            }
            if !fs::canonicalize(parent)?.starts_with(&workspace.0) {
                return Err(std::io::Error::other("packaged file escapes staging"));
            }
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?
                .write_all(content)?;
        }
        Ok(workspace)
    };
    write().map_err(|error| failure("materialize_failed", error, false))
}

#[cfg(test)]
#[path = "skill_runner_tests.rs"]
mod tests;
