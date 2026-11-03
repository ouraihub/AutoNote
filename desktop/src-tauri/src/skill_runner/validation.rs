use std::path::{Component, Path};
use std::sync::Arc;

use aether_runtime::{Approval, AuthorizeContext, PermissionMode, ToolCall, ToolError, ToolSource};

use super::{Arguments, EXECUTION_NOTICE, MAX_TIMEOUT, Selection, SkillRunner, Snapshot, failure};

pub(crate) fn arguments(call: &ToolCall) -> Result<Arguments, ToolError> {
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

pub(crate) fn selected<'a>(run: &'a Selection, args: &Arguments) -> Option<&'a Arc<Snapshot>> {
    if run.token != args.snapshot {
        return None;
    }
    run.skills.iter().find(|skill| {
        skill.id == args.skill_id
            && skill.revision == args.revision
            && skill.scripts.contains(&args.path)
    })
}

pub(crate) fn safe_relative(path: &str) -> bool {
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

pub(super) fn authorize(
    runner: &SkillRunner,
    call: &ToolCall,
    ctx: &AuthorizeContext<'_>,
) -> Approval {
    if call.name != "skill_run" {
        return ctx.proposed;
    }
    if ctx.proposed == Approval::Deny {
        return Approval::Deny;
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
    let Ok(mut runs) = runner.runs.lock() else {
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
