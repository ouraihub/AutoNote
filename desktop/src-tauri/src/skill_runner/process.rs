use aether_runtime::{CancellationToken, ToolCall, ToolError, ToolOutput};

use super::{SkillRunner, arguments, failure, materialize, output, selected};

pub(super) async fn execute(
    runner: &SkillRunner,
    call: &ToolCall,
    cancel: &CancellationToken,
) -> Result<ToolOutput, ToolError> {
    if call.name != "skill_run" {
        return Err(ToolError::not_found());
    }
    let args = arguments(call)?;
    let snapshot = {
        let mut runs = runner
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
    let root = runner.root.clone();
    let workspace = tokio::task::spawn_blocking(move || materialize(&root, &snapshot))
        .await
        .map_err(|error| failure("internal", error, false))??;
    let payload = crate::skill_process::run_script(
        &workspace.0,
        &crate::skill_process::Arguments {
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
    Ok(output::tool_output(payload))
}
