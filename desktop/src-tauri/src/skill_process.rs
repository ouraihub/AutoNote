//! Bounded output and process-tree lifetime for packaged scripts; not a sandbox.

use process_wrap::tokio::{CommandWrap, KillOnDrop};
use serde_json::{Value, json};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy)]
pub(super) enum ScriptLanguage {
    Shell,
    PowerShell,
    Python,
    JavaScript,
}

pub(super) struct Arguments {
    pub path: String,
    pub args: Vec<String>,
    pub timeout_seconds: u64,
}

#[derive(Debug)]
pub(super) struct ToolError {
    pub code: String,
    pub message: String,
    pub unknown: bool,
}

fn failure(code: &str, message: impl ToString, unknown: bool) -> ToolError {
    ToolError {
        code: code.into(),
        message: message.to_string(),
        unknown,
    }
}

#[cfg(test)]
#[path = "skill_process_tests.rs"]
mod tests;
pub(super) fn interpreter(
    path: &str,
) -> Option<(ScriptLanguage, &'static str, &'static [&'static str])> {
    match Path::new(path).extension()?.to_str()? {
        "py" => Some((
            ScriptLanguage::Python,
            if cfg!(windows) {
                "python.exe"
            } else {
                "python3"
            },
            &["-B"],
        )),
        "js" | "mjs" | "cjs" => Some((
            ScriptLanguage::JavaScript,
            if cfg!(windows) { "node.exe" } else { "node" },
            &["--"],
        )),
        "sh" => Some((
            ScriptLanguage::Shell,
            if cfg!(windows) { "bash.exe" } else { "sh" },
            &[],
        )),
        "ps1" => Some((
            ScriptLanguage::PowerShell,
            if cfg!(windows) { "pwsh.exe" } else { "pwsh" },
            &["-NoLogo", "-NoProfile", "-NonInteractive", "-File"],
        )),
        _ => None,
    }
}

pub(super) fn safe_env(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    // An allowlist also removes interpreter hooks, preload flags and provider credentials.
    matches!(
        upper.as_str(),
        "PATH"
            | "PATHEXT"
            | "SYSTEMROOT"
            | "WINDIR"
            | "COMSPEC"
            | "TEMP"
            | "TMP"
            | "TMPDIR"
            | "HOME"
            | "USERPROFILE"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "LANG"
            | "LC_ALL"
            | "LC_CTYPE"
            | "TZ"
    )
}

fn program(name: &str, environment: &[(OsString, OsString)]) -> Result<PathBuf, ToolError> {
    let path = environment
        .iter()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value)
        .ok_or_else(|| failure("not_found", "interpreter PATH unavailable", false))?;
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| fs::canonicalize(candidate).ok())
        .ok_or_else(|| {
            failure(
                "not_found",
                format!("required interpreter is not installed: {name}"),
                false,
            )
        })
}

async fn drain(mut pipe: impl AsyncRead + Unpin) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let count = pipe.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(OUTPUT_LIMIT.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&chunk[..keep]);
        truncated |= keep < count;
    }
    Ok((bytes, truncated))
}

fn output_text(bytes: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if text.len() > OUTPUT_LIMIT {
        let mut boundary = OUTPUT_LIMIT;
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
    }
    text
}

pub(super) async fn run_script(
    cwd: &Path,
    args: &Arguments,
    cancel: &CancellationToken,
) -> Result<Value, ToolError> {
    let (_, name, prefix) = interpreter(&args.path)
        .ok_or_else(|| failure("not_allowed", "unsupported script language", false))?;
    let environment: Vec<_> = std::env::vars_os()
        .filter(|(name, _)| safe_env(&name.to_string_lossy()))
        .collect();
    let executable = program(name, &environment)?;
    let script = fs::canonicalize(cwd.join(&args.path))
        .map_err(|error| failure("not_found", error, false))?;
    if !script.starts_with(cwd) {
        return Err(failure("not_allowed", "script escaped staging", false));
    }
    if cancel.is_cancelled() {
        return Err(failure(
            "cancelled",
            "script cancelled before launch",
            false,
        ));
    }
    let mut command = CommandWrap::with_new(executable, |command| {
        command
            .args(prefix)
            .arg(script)
            .args(&args.args)
            .current_dir(cwd)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    });
    #[cfg(windows)]
    command
        .wrap(process_wrap::tokio::CreationFlags(
            windows::Win32::System::Threading::CREATE_NO_WINDOW,
        ))
        .wrap(process_wrap::tokio::JobObject);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    command.wrap(KillOnDrop);
    let mut child = command
        .spawn()
        .map_err(|error| failure("spawn_failed", error, false))?;
    let stdout = child
        .stdout()
        .take()
        .ok_or_else(|| failure("internal", "stdout missing", true))?;
    let stderr = child
        .stderr()
        .take()
        .ok_or_else(|| failure("internal", "stderr missing", true))?;
    let mut out = tokio::spawn(drain(stdout));
    let mut err = tokio::spawn(drain(stderr));
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(failure("cancelled", "script cancelled; filesystem or network effects may already have happened", true)),
        _ = tokio::time::sleep(Duration::from_secs(args.timeout_seconds)) => Err(failure("timeout", "script timed out; filesystem or network effects may already have happened", true)),
        status = child.wait() => status.map_err(|error| failure("process_failed", error, true)),
    };
    // Kill descendants even if the root already exited, before awaiting inherited pipes.
    let killed = match child.start_kill() {
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || (cfg!(unix) && error.raw_os_error() == Some(3)) =>
        {
            Ok(())
        }
        result => result,
    };
    let reaped = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    drop(child);
    let collect = async {
        let stdout = (&mut out)
            .await
            .map_err(|error| failure("output_failed", error, true))?
            .map_err(|error| failure("output_failed", error, true))?;
        let stderr = (&mut err)
            .await
            .map_err(|error| failure("output_failed", error, true))?
            .map_err(|error| failure("output_failed", error, true))?;
        Ok::<_, ToolError>((stdout, stderr))
    };
    let collected = tokio::time::timeout(Duration::from_secs(5), collect).await;
    out.abort();
    err.abort();
    let ((stdout, out_truncated), (stderr, err_truncated)) = collected
        .map_err(|_| failure("output_failed", "script output pipes did not close", true))??;
    let status = result?;
    if let Err(error) = killed {
        return Err(failure("process_tree_failed", error, true));
    }
    reaped
        .map_err(|_| failure("process_tree_failed", "script tree did not exit", true))?
        .map_err(|error| failure("process_tree_failed", error, true))?;
    let payload = json!({"exitCode":status.code(), "success":status.success(),
        "stdout":output_text(&stdout), "stderr":output_text(&stderr),
        "stdoutTruncated":out_truncated, "stderrTruncated":err_truncated});
    Ok(payload)
}
