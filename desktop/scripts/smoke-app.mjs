// 打包产物冒烟检查：对着 build-app.bat 收集出来的 exe 跑，而不是 `cargo run`。
//
//   node scripts/smoke-app.mjs                # 默认 dist\AutoNote\AutoNote.exe
//   node scripts/smoke-app.mjs "别处\AutoNote.exe"
//
// 为什么要在打包产物上跑：release 才启用 `windows_subsystem = "windows"`、
// LTO 和 `panic = "abort"`，debug 能起而 release 起不来是可能的。
//
// 做法：把 exe 复制进一个临时目录再启动。数据目录固定在 exe 旁的 data\，所以
// 数据落在临时目录里，不碰 dist\AutoNote\data 或安装目录下的真实笔记库。启动后等库文件和
// 日志出现，读 schema_migrations 确认迁移真的跑了，然后结束进程、删临时目录。
//
// 为什么是 .mjs 而不是 .bat：判据要读 SQLite，.bat 做不到；中文输出也只有
// Node 能稳定打印（cmd.exe 按 OEM 代码页读 .bat）。

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
const exe = process.argv[2] ?? path.join(root, "dist", "AutoNote", "AutoNote.exe");
const STARTUP_TIMEOUT_MS = 20_000;

if (!existsSync(exe)) {
  console.error(`ERROR: 找不到 ${exe}`);
  console.error("       先跑 scripts\\build-app.bat，或传 exe 路径进来。");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const stage = mkdtempSync(path.join(tmpdir(), "autonote-smoke-"));
const stagedExe = path.join(stage, path.basename(exe));
const dataDir = path.join(stage, "data");
const libraryDb = path.join(dataDir, "library.db");
const logFile = path.join(dataDir, "logs", "autonote.log");

console.log("============================================");
console.log(`  AutoNote 打包产物冒烟 — ${exe}`);
console.log(`  临时目录 ${stage}`);
console.log("============================================\n");

copyFileSync(exe, stagedExe);

const child = spawn(stagedExe, [], { cwd: stage, stdio: "ignore" });
let exitCode = null;
child.on("exit", (code) => {
  exitCode = code;
});

const deadline = Date.now() + STARTUP_TIMEOUT_MS;
while (Date.now() < deadline && exitCode === null && !(existsSync(libraryDb) && existsSync(logFile))) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
// 给窗口和 WebView 一点时间：库文件先于窗口创建，进程在建窗阶段崩也要抓到。
await new Promise((resolve) => setTimeout(resolve, 3_000));

check("进程启动后仍在运行", exitCode === null, `exit ${exitCode}`);
check("数据落在 exe 旁的 data\\", existsSync(libraryDb), libraryDb);
check("日志写入 data\\logs\\autonote.log", existsSync(logFile), logFile);

if (existsSync(libraryDb)) {
  const db = new DatabaseSync(libraryDb, { readOnly: true });
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  db.close();
  check("迁移已执行（schema_migrations 有记录）", Number(row?.version) >= 1, JSON.stringify(row));
}

if (existsSync(logFile)) {
  const log = readFileSync(logFile, "utf8");
  check("日志含启动记录", log.includes("AutoNote starting"), log.slice(-200));
  check("日志无 ERROR", !/\bERROR\b/.test(log), log.slice(-400));
}

if (exitCode === null) {
  spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

console.log("\n============================================");
console.log(`  通过 ${passed}   失败 ${failed}`);
console.log("============================================");
process.exit(failed > 0 ? 1 : 0);
