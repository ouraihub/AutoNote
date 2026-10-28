#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::*;

fn fixture(source: &str) -> (tempfile::TempDir, PathBuf, Arguments) {
    let dir = tempfile::tempdir().unwrap();
    let cwd = fs::canonicalize(dir.path()).unwrap();
    fs::write(cwd.join("run.js"), source).unwrap();
    (
        dir,
        cwd,
        Arguments {
            path: "run.js".into(),
            args: Vec::new(),
            timeout_seconds: 10,
        },
    )
}

#[tokio::test]
async fn actual_script_arguments_output_cap_and_filtered_environment() {
    let (_dir, cwd, mut args) = fixture(
        "console.log(JSON.stringify({arg:process.argv[2],cwd:process.cwd(),secret:process.env.OPENAI_API_KEY??null,hook:process.env.NODE_OPTIONS??null}));process.stderr.write('x'.repeat(100000));process.stdout.write('y'.repeat(100000));",
    );
    args.args = vec!["literal ; $HOME && no shell".into()];
    let result = run_script(&cwd, &args, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["success"], true);
    let stdout = result["stdout"].as_str().unwrap();
    let first: Value = serde_json::from_str(stdout.lines().next().unwrap()).unwrap();
    assert_eq!(first["arg"], args.args[0]);
    assert_eq!(first["secret"], Value::Null);
    assert_eq!(first["hook"], Value::Null);
    assert_eq!(stdout.len(), OUTPUT_LIMIT);
    assert_eq!(result["stderr"].as_str().unwrap().len(), OUTPUT_LIMIT);
    assert_eq!(result["stdoutTruncated"], true);
    assert_eq!(result["stderrTruncated"], true);
    for key in [
        "OPENAI_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "PASSWORD",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "LD_PRELOAD",
        "BASH_ENV",
        "GITHUB_TOKEN",
        "SSH_AUTH_SOCK",
    ] {
        assert!(!safe_env(key), "{key}");
    }
    assert!(safe_env("Path"));
}

fn descendant_source(exit_root: bool) -> String {
    let grandchild = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.send(c.pid);setInterval(()=>{},1000)";
    format!(
        "const c=require('node:child_process').spawn(process.execPath,['-e',{}],{{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true}});c.on('message',pid=>{{require('node:fs').writeFileSync('pid',String(pid));{}}});",
        serde_json::to_string(grandchild).unwrap(),
        if exit_root {
            "process.exit(0)"
        } else {
            "setInterval(()=>{},1000)"
        }
    )
}

async fn assert_descendant_ended(cwd: &Path) {
    let pid = fs::read_to_string(cwd.join("pid")).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        #[cfg(windows)]
        let ended = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "if(Get-Process -Id {pid} -ErrorAction SilentlyContinue){{exit 1}}else{{exit 0}}"
                ),
            ])
            .status()
            .unwrap()
            .success();
        #[cfg(unix)]
        let ended = {
            // A killed orphan may await init's reap; a zombie cannot execute.
            let output = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", pid.trim()])
                .output()
                .unwrap();
            let state = std::str::from_utf8(&output.stdout).unwrap().trim();
            assert!(
                output.status.success() || (output.status.code() == Some(1) && state.is_empty()),
                "cannot inspect descendant {pid}: {:?}",
                output
            );
            state.is_empty() || state.starts_with('Z')
        };
        if ended {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "descendant {pid} survived"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn descendant_check_rejects_running_process_but_accepts_unreaped_exit() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new("sh")
        .args(["-c", "exec sleep 30"])
        .spawn()
        .unwrap();
    fs::write(dir.path().join("pid"), child.id().to_string()).unwrap();
    let running = tokio::time::timeout(
        Duration::from_millis(100),
        assert_descendant_ended(dir.path()),
    )
    .await;
    child.kill().unwrap();
    let exited =
        tokio::time::timeout(Duration::from_secs(2), assert_descendant_ended(dir.path())).await;
    child.wait().unwrap();
    assert!(running.is_err(), "running descendant was accepted as ended");
    assert!(
        exited.is_ok(),
        "killed but unreaped descendant was rejected"
    );
}

#[tokio::test]
async fn normal_root_exit_also_ends_descendants() {
    let (_dir, cwd, args) = fixture(&descendant_source(true));
    let result = run_script(&cwd, &args, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["success"], true);
    assert_descendant_ended(&cwd).await;
}

#[tokio::test]
async fn timeout_ends_entire_process_tree() {
    let (_dir, cwd, mut args) = fixture(&descendant_source(false));
    args.timeout_seconds = 1;
    let error = run_script(&cwd, &args, &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert!(error.unknown);
    assert_descendant_ended(&cwd).await;
}

#[tokio::test]
async fn cancellation_ends_entire_process_tree() {
    let (_dir, cwd, args) = fixture(&descendant_source(false));
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        signal.cancel();
    });
    let error = run_script(&cwd, &args, &cancel).await.unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert!(error.unknown);
    assert_descendant_ended(&cwd).await;
}

#[tokio::test]
async fn prelaunch_cancel_and_escape_do_not_execute() {
    let (_dir, cwd, mut args) = fixture("throw Error('must not execute')");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = run_script(&cwd, &args, &cancel).await.unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert!(!error.unknown);
    args.path = "../run.js".into();
    assert!(
        run_script(&cwd, &args, &CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn invalid_utf8_output_remains_within_byte_cap() {
    let (_dir, cwd, args) = fixture(
        "process.stdout.write(Buffer.alloc(100000,255));process.stderr.write(Buffer.alloc(100000,255));",
    );
    let result = run_script(&cwd, &args, &CancellationToken::new())
        .await
        .unwrap();
    assert!(result["stdout"].as_str().unwrap().len() <= OUTPUT_LIMIT);
    assert!(result["stderr"].as_str().unwrap().len() <= OUTPUT_LIMIT);
    assert_eq!(result["stdoutTruncated"], true);
    assert_eq!(result["stderrTruncated"], true);
}
