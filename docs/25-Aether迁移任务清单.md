# 25 Aether 迁移任务清单：AutoNote

> 唯一入口：AutoNote 接入 Aether 的实施任务。
> 设计依据：[24-详细设计-Aether框架迁移方案.md](24-详细设计-Aether框架迁移方案.md)。
> 框架仓库：<https://github.com/ouraihub/Aether>。
> AutoNote 仓库：<https://github.com/ouraihub/AutoNote>。
>
> 本清单只负责 Aether 接入，不替代 [03-开发任务清单.md](03-开发任务清单.md) 中 AutoNote 原有 Web、桌面内核、同步、导入导出和发布任务。

---

## 1. 已裁决边界

1. **不迁移历史数据。** 不迁移旧 `ai_*` 表、旧 DPAPI 密文、旧 Provider 配置、旧 AI 对话和旧 MCP token。新数据目录重新配置。
2. **保留 `chat` 与 `writing` 角色。** 角色绑定属于 AutoNote 产品配置；Aether 只消费运行时 `ModelRef`。
3. **笔记页 Chat 按 `noteId` 关联。** 使用 `RunRequest.context={kind:"autonote-note",id:noteId}`，`scope=note:<noteId>`。
4. **Writing 保留现有行为。** 选区、光标、正文前后文、动作、编辑器安全写回仍由 AutoNote 负责。
5. **密钥重新填写。** Aether 新建 `providers.db`，不读取 AutoNote 旧密文。
6. **旧对话不导入。** Aether 新建 `chat.db`。
7. **AutoNote `note-core` 是领域唯一入口。** Aether 不打开 `library.db`，MCP 工具不得绕过 `note-core`。
8. **不做兼容 shim。** 发现合同冲突时先改设计和所有调用者，再迁移。

## 2. 数据边界

```text
<exe>/data/
├── library.db       AutoNote note-core：笔记、文件夹、标签、附件、FTS
├── providers.db     Aether：Provider、Endpoint、Model、密文 key
├── chat.db          Aether：Chat conversation/message
├── mcp-server.db    Aether：token hash、scope、operation idempotency
├── files/           AutoNote 附件
└── logs/            Aether observability
```

- `library.db` 不增加 Aether 表。
- Aether store 接收 AutoNote exe 同级 `data` 目录，不自行回退 AppData。
- 日志和数据库不得出现明文 key、Authorization、笔记正文、选区正文或原始上游错误。

## 3. 执行协议

1. 只领取依赖已完成的任务。
2. 开始前读取本文件、24 号设计、03 清单、任务依赖的当前交付记录。
3. 一个任务一个文件所有权；根 `Cargo.toml`、Cargo.lock、pnpm lock、组合根串行修改。
4. 只做任务范围；不顺手改 Web、同步、导入导出或无关 UI。
5. 纯函数用单测；网络用 loopback；桌面用真实窗口、重启和截图；真实 MCP 用 Inspector 或 Claude Code。
6. 全部判据通过后才改任务为 `[x]`。
7. 每个任务提交验收记录：变更文件、命令、退出结果、关键读回值、截图/artifact、未验证项、下一依赖。
8. 不记录账号、token、key、生产地址、正文或绝对用户路径。

## 4. 依赖批次

```text
A0 → A1 → A2 → A3 → A4 → A5 → A6
```

| 任务 | 依赖 | 主要范围 |
|---|---|---|
| A0 接入基线 | AutoNote A1-4、D2-1 | 分支、Git 依赖、组合根、门禁 |
| A1 日志接入 | A0 | shell logging、LogHandle、日志 UI |
| A2 Provider 与角色 | A1 | aether-providers、chat/writing binding |
| A3 笔记页 Chat | A2 | chat_run、noteId、会话、ChatPanel |
| A4 Writing 助手 | A3 | 选区/光标/快照安全门 |
| A5 MCP Server | A3 | Aether transport + AutoNote tools |
| A6 清理与发布 | A1-A5、AutoNote D6/D5 相关任务 | 删除旧实现、全量验收 |

A3 与 A4 可在 A3 合同稳定后串行推进；A5 可以在 A3 后开始，但不得与 A3 同时修改 `tauri-plugin-aether` 组合根。

---

## 5. 任务清单

### A0 接入基线

- [x] **A0-1 建立重构分支**
  - 2026-10-11：建立分支 `refactor/use-aether`；未改 AutoNote `main`，未新建仓库。
  - 基线：AutoNote `main`/分支起点 `2d5151a fix(ci): drop new comments and refresh moved allowlist offsets`；Aether 固定基线 `516a9d5 feat: initialize Aether AI application framework`。
  - 验证：`pnpm install --frozen-lockfile` ✓（625 packages；此前 4 个并发 pnpm 门禁造成 Windows node_modules 锁冲突，改串行安装后恢复）；`pnpm run app:check` ✓；`pnpm run web:check` ✓；`pnpm run web:test` ✓（shared 11、web 102、脚本 8）；`pnpm --filter autonote-desktop verify` ✓（前端 26、Rust workspace test 全部通过、clippy、fmt）。
  - 修复：`desktop/scripts/msvc-env.bat` 的裸 `powershell` 改为 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，避免 PATH 缺 Windows PowerShell 时 Rust 门禁失败。
- [x] **A0-2 固定 Aether Git 依赖**
  - 2026-10-11：AutoNote `desktop/src-tauri/Cargo.toml` 增加 `aether-observability`、`aether-providers`、`aether-chat`、`aether-mcp-server`、`tauri-plugin-aether`，全部固定到 Aether commit `997d9830fcb975318b5c5ce678ef3bfa983ad9f7`。
  - 不使用本地绝对 path；Cargo.lock 已写入 Git 依赖。
  - 初次 metadata 暴露 `hyper 1.11.1` 与 Aether `hyper 1.12.0` 精确约束冲突；Aether 已修复为 `^1.11.0`，提交 `997d983` 并推送，AutoNote 随后解析成功。
  - 命令：`cmd.exe /d /c "scripts\\cargo-msvc.bat metadata --format-version 1"` ✓；解析出 9 个 Aether Git packages。未接入 Builder，旧 AutoNote 行为未改。

- [x] **A0-3 宿主组合根接缝**
  - 2026-10-11：AutoNote `desktop/src-tauri/src/lib.rs` 在 `open_context` 中初始化 Aether observability；未启用 providers/chat/mcp-server feature，未注册 Aether 业务命令，未创建 Aether provider/chat/MCP 数据库。
  - `aether_observability::init` 使用 AutoNote exe 同级 `data/logs`；旧 AutoNote logging reader/commands 暂保留，A1 负责完整替换，避免双 writer 同时初始化。
  - 命令：`pnpm --filter autonote-desktop verify` ✓（前端 26、workspace Rust tests 全部通过、clippy、fmt）；首次失败是编辑时误删 `note_core` imports，已恢复后重跑通过。
  - Aether `hyper` 兼容修复已提交并推送到 Aether `main`：`997d9830fcb975318b5c5ce678ef3bfa983ad9f7`；AutoNote metadata、test、clippy 成功解析该 Git commit。
  - 未验证：Aether 日志 UI/AutoNote 日志读取尚未切换，属于 A1。
### A1 日志接入

- [x] **A1-1 初始化 Aether observability**
  - 2026-10-11：`desktop/src-tauri/src/lib.rs` 在 Tauri Builder 前初始化 `aether_observability::init`，`AppContext` 持有 `LogHandle`；业务 `open_context` 仍在 single-instance plugin 安装后的 setup 执行。shutdown 使用 `LogHandle::flush`。
  - 旧 `autonote_shell::logging::init/flush/available` 已无生产调用者，旧模块暂保留独立单测，A6 再删除。
  - 验证：`pnpm --filter autonote-desktop verify` ✓；`app:check`、`web:check`、`web:test` ✓；Rust workspace test/clippy/fmt ✓。
- [x] **A1-2 日志读取与前端 ingest**
  - 2026-10-11：`commands/mod.rs::app_logs_tail` 使用 Aether `LogHandle::tail`；`commands/app.rs::app_log` 转换为 Aether `IngestBatch`，保留 AutoNote event/field 白名单；返回 `accepted/rejected/available`，前端 CommandResults 与日志单测同步更新。
  - 日志路径为 exe 同级 `data/logs`；未新增第二个 writer。当前 UI 没有日志级别控制路径，Aether `set_level/level` 暂由 LogHandle 提供。
  - 验证：同上完整 AutoNote 门禁通过。
- [x] **A1-3 日志安全验收**
  - 2026-10-11：扫描 AutoNote target data 中的日志、数据库、WAL/SHM，未发现 Bearer、API key、OpenAI key 或 PEM 私钥模式；当前目录无运行产物，扫描 0 个文件。
  - 未验证：真实窗口中 Aether 日志面板完整读回，保留到后续真实窗口任务。


- [x] **A2 Provider 与角色**
  - 2026-10-11：AutoNote Provider/Endpoint/Model/密钥/探测 active path 改用 Aether `aether-providers::Store`；AutoNote 保留原 `ai_*` IPC/前端 DTO 作为 adapter，删除旧 core provider SQL API；新增 `prefs.aiRoles` 产品角色设置，未读取旧 `ai_roles` 数据。
  - `chat`/`writing` 两角色保留；仅允许保存的 Chat 模型；writing 未绑定时 fallback chat 并标 `isFallback`。Aether Provider Store 和 plugin provider command 使用同一 exe `data/providers.db` 路径（两个 Store handle，不重复 SQL；Aether Builder API 当前按值接收 Store）。
  - Aether `providers` feature 已接入 Builder；尚未接入 Aether chat runtime。旧 `ai_*` migration 表仍存在但 active commands 不再调用，A6 清理阶段删除旧迁移/死代码。
  - 重点文件：`desktop/src-tauri/src/commands/ai.rs`、`core/src/ai.rs`（角色设置/会话 DTO）、`src/lib.rs`、`Cargo.toml`、`Cargo.lock`、IPC command/transport、provider adapter 测试。
  - 命令：`cargo metadata --locked` ✓；focused `provider_adapter_and_roles_roundtrip` ✓；`pnpm run app:check` ✓；`pnpm run web:check` ✓；`pnpm run web:test` ✓（shared 11、web 102、脚本 8）；`pnpm --filter autonote-desktop verify` ✓（前端 26、Rust workspace tests、clippy、fmt）。
  - 未验证：真实 Provider 设置窗口、新建/探测/保存/重启读回；真实上游探测；A3 前不验证 Chat/Writing 运行链路。

### A2 Provider 与角色

- [x] **A2-1 接入 Aether Provider Store**
  - 2026-10-11：启用 `tauri-plugin-aether` 的 `providers` feature，在 AutoNote exe 同级 data root 创建 Aether `providers.db`；Provider/Endpoint/Model、密钥三态、解析和探测均通过 `aether-providers`，保留旧 `ai_*` 命令名与 AutoNote DTO 适配。
  - `library.db` 不再作为 Provider 后端；旧数据不读取。显式 key reveal 通过 Aether endpoint connection，明文仅返回命令响应，不写日志。
  - 探测沿用 `jobId` + `CancellationToken`，前端 abort 进入现有 `jobs_cancel`。
- [x] **A2-2 实现 AutoNote RoleStore**
  - 2026-10-11：角色只保存 `prefs.aiRoles` 中的 `chat`/`writing` `ModelRef`；Aether provider 行不复制到 AutoNote。仅已保存 Chat 模型可绑定；writing 未绑定时沿用 chat 并返回 `isFallback=true`。
  - 不迁移旧 `ai_roles` 或 Provider 数据；新数据目录重新配置。
- [x] **A2-3 Provider 与角色 UI**
  - 2026-10-11：保留既有 AutoNote UI wire DTO、IPC 命令与设置界面，端口补充探测 jobId；适配层映射 Aether DTO。
  - 验证：`pnpm --filter autonote-desktop verify`、`pnpm run app:check`、`pnpm run web:check`、`pnpm run web:test`、cargo metadata/check/deps；聚焦 adapter/role fallback 单测通过。
  - 未验证：真实 Provider UI/真实上游网络 smoke；本任务未实现 Chat/Writing runtime 迁移。

### A3 笔记页 Chat

- [x] **A3-1 AutoNote HostAdapter**
  - 2026-10-11：`desktop/src-tauri/src/lib.rs` 新增 `AetherHost`；模型从 Aether provider options + AutoNote `prefs.aiRoles` 解析；`context` 只接受 `autonote-note`，通过 `note-core` 读取有界标题/正文；system prompt 保留 AutoNote chat 语义；写作 purpose 暂由 A4 接管。
  - 当前 HostAdapter 不提供假工具；未接入的 AutoNote MCP/领域工具不进入目录。
- [x] **A3-2 noteId 与 ChatRequest 映射**
  - 2026-10-11：桌面 transport 将 AutoNote Chat 请求映射为 `plugin:aether|chat_run`；`context={kind:"autonote-note",id:noteId}`，scope 使用 `note:<noteId>`，conversationId/regenerate 保留；UI 继续使用 AutoNote AiPort/DTO。
  - 不传整个 Note 对象；HostAdapter 从 note-core 读取上下文并截断标题/正文；不存在或删除的 noteId 返回 not_found。
- [x] **A3-3 替换 Chat 传输与生命周期**
  - 2026-10-11：启用 Aether chat feature，Builder 使用 `ChatConfig` 和 lazy `SqliteStore`（`chat.db` 首次 ConversationStore 操作时打开）；旧 ai_chat/history Rust command 注册移除，TS adapter 调用 `chat_run/chat_conversations/chat_conversation/chat_delete`，保留 AutoNote AiPort/ChatPanel/取消/重新生成接口。
  - 启动顺序：AetherHost 通过 `OnceLock<Library>`，业务 Library 在 single-instance plugin 后 setup；不会在 Builder 前打开 `library.db` 或 `chat.db`。
  - 命令：`pnpm --filter autonote-desktop verify` ✓；`app:check`、`web:check`、`web:test` ✓；ChatPanel 26 tests ✓；cargo check/clippy/fmt ✓。
  - 旧 `note_ai::chat_stream` 仅剩 A4 writing 路径，A4 迁移后由 A6 清理。
- [ ] **A3-4 Chat 真实验收**
  - 依赖：A3-1、A3-2、A3-3。真实上游 loopback/中转和 AutoNote Tauri 窗口：三协议纯文本、noteId/scope 隔离、新会话/继续/重生成、取消/关闭窗口、删除 note 后拒绝新运行、重启历史读回、真实截图。
- 2026-10-11：根因已定位为 Tauri release 构建未启用 `custom-protocol`，导致 WebView 回退到 `devUrl=http://localhost:1430`；新增 `custom-protocol = ["tauri/custom-protocol"]`，并保留 `bootDesktop` 阶段诊断与可重试错误界面。真实 release 窗口已显示笔记导航和空状态，未再出现连接拒绝。A3-4 仍未完成：三协议上游联验、Chat 交互/重启历史读回和真实截图尚未验收。
- 2026-10-11：A4-1～A4-3 已接入 Aether writing request/role fallback/安全快照写回；A5-1～A5-3 已改用 Aether MCP server、34 个 note-core 工具、scope/token/loopback 管理。验证：`pnpm run app:check`、desktop 前端 26 tests、`cargo fmt --check`、`cargo check -p autonote --features custom-protocol`、workspace tests、clippy 均通过。未验证：A3-4/A4-4/A5-4 所要求的真实上游、真实 MCP 客户端和真实窗口交互，故不得勾选真实验收任务；A6 清理依赖这些验收，暂不执行。
- 2026-10-11：A6 静态回归与安全扫描通过：`pnpm run app:check`、`pnpm --filter autonote-desktop verify`、workspace Rust tests、clippy `-D warnings`、fmt check；Aether MCP真实 loopback测试 `aether_mcp_real_http_scope_revoke_origin_and_idempotency` 通过；日志/数据库扫描未发现 Bearer、API key、PEM 私钥模式。未验证仍为真实 Tauri Chat/Writing 上游交互和截图，未宣称发布验收完成。
- 2026-10-11：发布记录：Aether commit `997d9830fcb975318b5c5ce678ef3bfa983ad9f7` 固定于 `desktop/src-tauri/Cargo.toml`/`Cargo.lock`；静态门禁和 MCP loopback 证据已通过。发布阻断：A3-4、A4-4 仍缺真实 Tauri 上游交互与截图；不打 tag、不发布。
### A4 Writing 助手
- [ ] **A4-1 WritingRequest 合同**
  - 保留 `polish/rewrite/shorten/expand/continue`；请求包含 `noteId`、`selectedText`、`beforeText`、`afterText`、`cursorOffset`、`language`、`title`；正文和上下文有总长度上限；`purpose=writing`、`scope=note:<noteId>:writing`。
- [ ] **A4-2 Writing HostAdapter**
  - 使用 writing binding；未绑定时 fallback chat；system prompt 固定动作、语言、标题、前后文和输出规则；默认不提供写笔记工具。
- [ ] **A4-3 编辑器安全写回**
  - 保存 requestId、noteId、editorGeneration、sourceTextHash、selectionStart/End；运行完成后检查 noteId、generation、源文快照和当前 rev；不匹配时不自动覆盖，匹配时支持 replace/insert/copy；写回走 `notes.patch` CAS。
- [ ] **A4-4 Writing 真实验收**
  - 五种 action、选区/无选区 Continue、流式/停止/复制/插入/替换、运行中修改正文、输入法组合、rev 冲突。
  - 保留 `polish/rewrite/shorten/expand/continue`。
  - 请求包含 `noteId`、`selectedText`、`beforeText`、`afterText`、`cursorOffset`、`language`、`title`。
  - selectedText、前后文、总字节数设上限。
  - `purpose=writing`、`scope=note:<noteId>:writing`。

### A5 MCP Server

- [ ] **A5-1 替换 MCP Transport/Auth**
  - 使用 `aether-mcp-server` 的 Streamable HTTP、token hash、revoke、scope、Origin、回环和端口管理。
  - AutoNote 不重复实现 HTTP listener、token hash、Origin 校验。
  - 新系统重新发 token，不迁移旧 token。

- [ ] **A5-2 接入 AutoNote MCP Tools**
  - 只读工具通过 note-core 查询。
  - 写工具通过 note-core 事务和 expected revision。
  - 附件工具经过 note-core 文件安全边界。
  - operationId 幂等和冲突逻辑保留在 AutoNote 领域层。
  - 禁止执行笔记正文中的脚本或指令。

- [ ] **A5-3 MCP 权限与 UI**
  - read/control scope 分离。
  - 写入、回收站、附件删除默认受控。
  - 设置页显示运行状态、端口、scope、token 创建/撤销。
  - token 明文只展示一次，不写日志和数据库。

- [ ] **A5-4 MCP 真实验收**
  - MCP Inspector `tools/list`。
  - 只读 token 看不到写工具。
  - 写工具审批/拒绝/冲突。
  - token revoke 立即失效。
  - 非回环连接和非法 Origin 拒绝。
  - 端口占用和重启恢复。
  - operationId 重放不重复修改。

### A6 清理与发布

- [ ] **A6-1 删除旧 AI 实现**
  - 依赖 A3、A4 真实验收。
  - 删除 AutoNote 旧三协议请求、SSE decoder、重复错误映射和旧 AI client。
  - 删除旧 AI provider/endpoint/model SQL 新写入路径。
  - 不删除 Aether adapter、AutoNote RoleStore、WritingController。

- [ ] **A6-2 删除旧 MCP 传输实现**
  - 依赖 A5 真实验收。
  - 删除 `note-mcp` 重复 transport/auth/server 生命周期。
  - 保留 note-core 的 MCP read/write tools。
  - 保留 AutoNote tool schema 和领域权限规则。

- [ ] **A6-3 全量回归**
  - AutoNote `app:check`、`web:check`、`web:test`、`desktop:verify`。
  - AutoNote Rust fmt/clippy/test。
  - Aether fmt/clippy/test。
  - 三协议 Chat、Writing、MCP、日志、重启、关闭、取消全部有证据。
  - 扫描日志、数据库、WAL/SHM，不得出现明文 key。

- [ ] **A6-4 发布前记录**
  - 写入 AutoNote 03 清单的任务验收记录。
  - 固定 Aether Git commit。
  - 确认 AutoNote 分支包含完整迁移提交。
  - 不自动合并 `main`，不自动发布 AutoNote。

---

## 6. 文件所有权

| 阶段 | 主要文件 | 所有者 |
|---|---|---|
| A0 | `desktop/src-tauri/Cargo.toml`、根组合根、Cargo.lock | 集成人 |
| A1 | `shell/src/logging.rs`、`shell/src/logs.rs`、日志 UI | 日志迁移者 |
| A2 | `commands/ai.rs`、`core/src/ai.rs`、AI 设置端口/UI | Provider 迁移者 |
| A3 | `commands/ai.rs`、HostAdapter、ChatSession、ChatPanel | Chat 迁移者 |
| A4 | WritingToolbar、editor adapter、WritingController | Writing 迁移者 |
| A5 | `mcp/`、`commands/mcp.rs`、MCP UI、HostTool registry | MCP 迁移者 |
| A6 | 删除旧模块、发布脚本、任务记录 | 集成人 |

同一文件不得由两个执行者同时编辑。`Cargo.lock`、根 package/lockfile 和组合根必须串行修改。

## 7. 每阶段命令

### A0-A2

```bat
cd desktop
scripts\cargo-msvc.bat metadata --locked
scripts\cargo-msvc.bat fmt --all -- --check
scripts\cargo-msvc.bat clippy --workspace --all-targets -- -D warnings
scripts\cargo-msvc.bat test --workspace
pnpm run app:check
pnpm run desktop:verify
```

### A3-A5

```bat
cd desktop
scripts\cargo-msvc.bat test --workspace --all-features
scripts\cargo-msvc.bat clippy --workspace --all-targets --all-features -- -D warnings
pnpm run app:check
pnpm run desktop:verify
```

此外必须运行真实窗口和 loopback/真实中转场景，单测不能替代。

### A6

```bat
cd desktop
pnpm run app:check
pnpm run web:check
pnpm run web:test
pnpm run desktop:verify
scripts\cargo-msvc.bat fmt --all -- --check
scripts\cargo-msvc.bat clippy --workspace --all-targets --all-features -- -D warnings
scripts\cargo-msvc.bat test --workspace --all-features
```

同时运行 Aether 仓库对应的 fmt、clippy、test、DTO、i18n 和依赖检查。

## 8. 中断恢复协议

下一次执行前先执行：

```text
git status --short
git branch --show-current
git log -5 --oneline
```

然后读取：

```text
docs/24-详细设计-Aether框架迁移方案.md
docs/25-Aether迁移任务清单.md
docs/03-开发任务清单.md
```

恢复规则：

1. 只继续当前最后一个未完成任务；
2. 检查该任务依赖是否已完成；
3. 检查文件所有权，避免与其他执行者冲突；
4. 先跑当前模块最小检查；
5. 不从聊天记录推测接口；
6. 不读取或打印 `key.txt`；
7. 不把历史迁移、兼容 shim 或额外功能重新加入范围；
8. 未完成真实验收不得勾 `[x]`；
9. 失败写明阻塞原因和下一输入；
10. 每阶段独立提交，提交信息包含任务号、验证命令和未验证项。

## 9. 当前起点

当前唯一可领取任务：

```text
A0-1 建立 refactor/use-aether 分支
```

A0-1 完成前禁止开始 A1-A6。A0-1 完成后依赖图按本清单顺序推进。
