use std::sync::Arc;

use aether_chat::risk::script_risk;
use aether_runtime::{
    Approval, HostTool, PermissionMode, RunRequest, ToolEffect, ToolSource, ToolSpec,
};
use serde_json::json;

use super::{
    EXECUTION_NOTICE, MAX_TIMEOUT, Selection, SkillRunner, Snapshot, risk_language,
    selection_choices,
};
pub(super) fn tools(runner: &SkillRunner, req: &RunRequest, run_id: &str) -> Vec<HostTool> {
    if req.purpose != "chat" || req.permission_mode == Some(PermissionMode::Plan) {
        return Vec::new();
    }
    let mut snapshots = Vec::new();
    for selected in &req.skills {
        let Ok(files) = runner.store.files(&selected.id, selected.revision) else {
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
            if !super::safe_relative(&file.path) {
                return Vec::new();
            }
            let Ok(content) = runner
                .store
                .file(&selected.id, selected.revision, &file.path)
            else {
                return Vec::new();
            };
            if file.kind == aether_skills::SkillFileKind::Script {
                if let Some((language, _, _)) = crate::skill_process::interpreter(&file.path) {
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
        if runner.store.files(&selected.id, selected.revision).is_err() {
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
    let choices = selection_choices(&snapshots);
    let Ok(mut runs) = runner.runs.lock() else {
        return Vec::new();
    };
    runs.insert(
        run_id.into(),
        Selection {
            token: token.clone(),
            skills: snapshots,
            calls: std::collections::HashMap::new(),
            used: std::collections::HashSet::new(),
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
                "timeoutSeconds":{"type":"integer","minimum":1,"maximum":MAX_TIMEOUT,"default":120}
            }}),
        approval: Approval::Ask, source: ToolSource::Host, effect: ToolEffect::Exec,
    }}]
}
