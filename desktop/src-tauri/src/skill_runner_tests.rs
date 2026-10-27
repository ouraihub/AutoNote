#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::*;

fn fixture(source: &str) -> (tempfile::TempDir, SkillRunner, RunRequest, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("package");
    fs::create_dir_all(package.join("scripts")).unwrap();
    fs::write(package.join("SKILL.md"), "---\nname: runner-test\ndescription: Exercise packaged scripts\n---\nRun the packaged script.").unwrap();
    fs::write(package.join("scripts/run.js"), source).unwrap();
    fs::create_dir(package.join("references")).unwrap();
    fs::write(package.join("references/input.txt"), "pinned reference").unwrap();
    let store = aether_skills::Store::open(root.path(), &[]).unwrap();
    let source = aether_skills::Source::Path(package.clone());
    let preview = store.preview(&source).unwrap();
    let installed = store.install(&source, &preview.digest, false).unwrap();
    let req = serde_json::from_value(
        json!({"purpose":"chat", "skills":[{"id":installed[0].id,"revision":installed[0].revision}],
        "input":"run the selected script", "regenerate":false, "language":"en-US"}),
    )
    .unwrap();
    let runner = SkillRunner::new(store, root.path().to_owned());
    (root, runner, req, package)
}

fn call(runner: &SkillRunner, req: &RunRequest, run_id: &str) -> ToolCall {
    let tools = runner.tools(req, run_id);
    let token = tools[0].spec.parameters["properties"]["snapshot"]["enum"][0]
        .as_str()
        .unwrap();
    ToolCall {
        id: "call-1".into(),
        name: "skill_run".into(),
        args: json!({
        "_executionNotice":EXECUTION_NOTICE, "snapshot":token,
        "skillId":req.skills[0].id,"revision":req.skills[0].revision,
        "path":"scripts/run.js","args":[]}),
    }
}

fn context(run_id: &str, mode: PermissionMode) -> AuthorizeContext<'_> {
    AuthorizeContext {
        run_id,
        mode,
        purpose: "chat",
        effect: ToolEffect::Exec,
        source: &ToolSource::Host,
        proposed: Approval::Auto,
    }
}

#[test]
fn selected_snapshots_and_permission_modes_cannot_expand() {
    let (_root, runner, req, _) = fixture("console.log('safe')");
    let tool = call(&runner, &req, "run-1");
    assert_eq!(
        runner.authorize(&tool, &context("run-2", PermissionMode::FullAccess)),
        Approval::Deny
    );
    let mut wrong = tool.clone();
    wrong.args["revision"] = json!(999);
    assert_eq!(
        runner.authorize(&wrong, &context("run-1", PermissionMode::FullAccess)),
        Approval::Deny
    );
    wrong = tool.clone();
    wrong.args["path"] = json!("../run.js");
    assert_eq!(
        runner.authorize(&wrong, &context("run-1", PermissionMode::FullAccess)),
        Approval::Deny
    );
    wrong = tool.clone();
    wrong.args["skillId"] = json!("not-selected");
    assert_eq!(
        runner.authorize(&wrong, &context("run-1", PermissionMode::FullAccess)),
        Approval::Deny
    );
    wrong = tool.clone();
    wrong.args["_executionNotice"] = json!("safe sandbox");
    assert_eq!(
        runner.authorize(&wrong, &context("run-1", PermissionMode::FullAccess)),
        Approval::Deny
    );
    let mut planning = req.clone();
    planning.permission_mode = Some(PermissionMode::Plan);
    assert!(runner.tools(&planning, "planning").is_empty());
    let mut writing = req.clone();
    writing.purpose = "writing".into();
    assert!(runner.tools(&writing, "writing").is_empty());
    let mut empty = req.clone();
    empty.skills.clear();
    assert!(runner.tools(&empty, "empty").is_empty());
    for (index, (mode, expected)) in [
        (PermissionMode::Default, Approval::Ask),
        (PermissionMode::AcceptEdits, Approval::Ask),
        (PermissionMode::Auto, Approval::Auto),
        (PermissionMode::FullAccess, Approval::Auto),
    ]
    .into_iter()
    .enumerate()
    {
        let mut next = tool.clone();
        next.id = format!("call-{index}");
        assert_eq!(runner.authorize(&next, &context("run-1", mode)), expected);
    }
    runner.finish("run-1");
    assert_eq!(
        runner.authorize(&tool, &context("run-1", PermissionMode::FullAccess)),
        Approval::Deny
    );
}

#[test]
fn auto_requires_approval_for_risky_selected_package() {
    let (_root, runner, req, _) = fixture("fetch('https://example.com')");
    let tool = call(&runner, &req, "run");
    assert_eq!(
        runner.authorize(&tool, &context("run", PermissionMode::Auto)),
        Approval::Ask
    );
}

#[tokio::test]
async fn approval_binds_exact_bytes_arguments_and_one_execution() {
    let (root, runner, req, package) =
        fixture("console.log(require('node:fs').readFileSync('references/input.txt','utf8'))");
    let tool = call(&runner, &req, "run");
    assert_eq!(
        runner.authorize(&tool, &context("run", PermissionMode::Default)),
        Approval::Ask
    );
    let mut altered = tool.clone();
    altered.args["args"] = json!(["changed after approval"]);
    assert_eq!(
        runner
            .execute(&altered, &CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "not_allowed"
    );
    fs::write(
        package.join("scripts/run.js"),
        "throw Error('replacement must not run')",
    )
    .unwrap();
    let source = aether_skills::Source::Path(package);
    let preview = runner.store.preview(&source).unwrap();
    runner
        .store
        .install(&source, &preview.digest, true)
        .unwrap();
    let output = runner
        .execute(&tool, &CancellationToken::new())
        .await
        .unwrap();
    assert!(output.text.contains("pinned reference"));
    assert_eq!(output.payload.unwrap()["success"], true);
    assert_eq!(
        runner
            .execute(&tool, &CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "not_allowed"
    );
    assert_eq!(
        fs::read_dir(root.path().join("staging/skill-runs"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn materialization_rejects_traversal_and_linked_staging() {
    for path in [
        "../escape",
        "/absolute",
        "scripts/../../escape",
        "scripts\\escape",
        "C:/escape",
        "scripts/a:stream",
        "scripts/CON.js",
        "scripts/dot.",
        "scripts//run.js",
    ] {
        assert!(!safe_relative(path), "{path}");
    }
    assert!(safe_relative("scripts/nested/run.js"));
    let (root, runner, req, _) = fixture("console.log('safe')");
    let _call = call(&runner, &req, "run");
    let runs = runner.runs.lock().unwrap();
    let snapshot = &runs["run"].skills[0];
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("staging")).unwrap();
        assert!(materialize(root.path(), snapshot).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
    #[cfg(windows)]
    {
        let outside = tempfile::tempdir().unwrap();
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(root.path().join("staging"))
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(materialize(root.path(), snapshot).is_err());
        fs::remove_dir(root.path().join("staging")).unwrap();
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
