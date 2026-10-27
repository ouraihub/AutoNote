# 24 详细设计：AutoNote 接入 Aether 框架

> 状态：Aether 迁移与桌面 AI 宿主接入基线；skills、MCP Client 和权限模式的接入合同见 §7–§9，不表示已完成集成验收。
> 目标：在不背历史数据兼容负担的前提下，把 AutoNote 的 AI、日志和本地 MCP 能力接入 Aether；保留 AutoNote 的笔记领域、同步和产品界面。
> 仓库：`https://github.com/ouraihub/AutoNote`
> 框架：`https://github.com/ouraihub/Aether`

---

## 1. 已裁决事项

本方案按以下用户决策编写：

1. **不考虑历史数据迁移。** 这是新系统，可以重新配置服务商、密钥和对话数据。旧 `ai_*` 表、旧密文、旧 AI 对话不需要兼容迁移。
2. **保留 `writing` 角色。** Aether 负责通用运行和流式；AutoNote 继续提供 `chat` 与 `writing` 的产品语义和模型绑定。
3. **笔记页对话关联 `noteId`。** 具体合同见 §5；对话属于 AutoNote 产品上下文，不把 `noteId` 塞进 Aether 通用 DTO。
4. **写作助手保持 AutoNote 当前行为。** 选区、光标、当前正文和动作仍由 AutoNote 组装；Aether 只负责模型连接、流式和取消。更优雅的统一方式见 §6。
5. **密钥重新配置。** 不迁移 AutoNote 的 DPAPI 密文；Aether 新建自己的 provider store，用户重新填写密钥。
6. **旧对话不迁移。** 新安装/新数据目录从空会话开始。

---

## 2. 总体边界

```text
┌──────────────────────────── AutoNote 产品 ────────────────────────────┐
│ packages/app / desktop UI                                             │
│                                                                       │
│ noteId、当前正文、选区、光标、writing action、角色、产品提示词        │
│                                                                       │
│ AutoNote HostAdapter                                                  │
│   select_model / system_prompt / context / tools / call_tool / auth    │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ tauri-plugin-aether
┌───────────────────────────────▼───────────────────────────────────────┐
│ Aether 框架                                                           │
│                                                                       │
│ aether-providers      provider / endpoint / model / secret            │
│ aether-chat           三协议流式 / usage / cancel / tool loop         │
│ aether-observability  tracing / rotate / tail / ingest                 │
│ aether-mcp-server     HTTP / token / scope / origin / lifecycle        │
│ aether-support        error / secret / net / SSE / db                  │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│ AutoNote 领域层                                                        │
│                                                                       │
│ note-core             notes / folders / tags / attachments / FTS       │
│ note-sync             remote cursor / pull / push / conflict           │
│ AutoNote MCP tools    read / search / write / attachment / idempotency  │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.1 Aether 负责

- 服务商、线路、模型配置；
- 密钥密文存储；
- HTTPS、回环和私网地址策略；
- Anthropic Messages、OpenAI Chat、OpenAI Responses；
- SSE、usage、首包/空闲超时和取消；
- 通用 Chat 对话运行；
- 工具目录、工具执行、审批、拒绝、未知结果和轮数上限；
- MCP Server 的传输、token、scope、Origin、端口和生命周期；
- 结构化日志、轮转、tail 和前端日志接入。

### 2.2 AutoNote 保留

- `note-core` 的 SQLite、迁移、事务、版本、FTS、附件和导入导出；
- `note-sync` 的远端绑定、游标、outbox、冲突和隔离队列；
- 笔记、文件夹、标签、编辑器和预览 UI；
- AutoNote 的 `chat` / `writing` 角色配置；
- 笔记上下文组装；
- 选区、光标、当前正文和写作动作；
- 笔记领域 MCP 工具实现；
- AutoNote 特有的设置、同步和产品文案。

### 2.3 明确禁止

- Aether 不直接打开 `library.db`；
- Aether 不依赖 `note-core`；
- AutoNote 不把 SQL、`rusqlite::Connection` 或领域事务暴露给 Aether；
- MCP 工具不绕过 `note-core` 直接改笔记；
- AutoNote 不复制一份 Provider、Chat 或 MCP 协议实现；
- 不为旧 `ai_*` 表、旧密文和旧会话增加兼容 shim。

---

## 3. 仓库与分支策略

### 3.1 仓库

不新开 AutoNote 仓库。继续使用：

```text
AutoNote main                 原产品基线
AutoNote refactor/use-aether  Aether 接入重构
Aether main                  通用框架
```

Aether 在 AutoNote 中初期使用固定 Git commit：

```toml
aether-chat = { git = "https://github.com/ouraihub/Aether.git", rev = "<固定提交>" }
```

AutoNote 始终保留 Aether 的固定 Git/package 提交引用。本次 skills 与权限模式接入不使用本地 `path`、包目录替换或依赖补丁；Aether 合并后，由父集成人统一更新 Cargo 与三个 `package.json` 的 SHA 及对应锁文件，前后端必须指向同一正式提交。

### 3.2 提交规则

每个迁移阶段独立提交，禁止一次性大提交：

```text
refactor: add Aether dependency baseline
refactor: route AutoNote logging through Aether
refactor: replace AutoNote AI client with Aether chat
refactor: adapt AutoNote writing assistant to Aether
refactor: route local MCP transport through Aether
refactor: remove obsolete AI and MCP implementations
```

每个提交必须满足：

- 工作区对应检查通过；
- 不包含 `key.txt`、数据库、日志、构建产物；
- 验收记录写入 AutoNote `docs/03-开发任务清单.md`；
- 未完成任务不勾 `[x]`。

---

## 4. 数据与存储决策

### 4.1 新系统数据库

不迁移旧数据。Aether 和 AutoNote 使用分工明确的数据库：

```text
<exe>/data/
├── library.db       AutoNote note-core：笔记领域唯一数据库
├── providers.db     Aether：provider / endpoint / model / encrypted key
├── chat.db          Aether：通用 AI 会话和消息
├── mcp-server.db    Aether：MCP token / scope / operations
├── skills.db        Aether：技能与修订快照
├── mcp-client.db    Aether：外部 MCP Client 配置与凭据
├── staging/skill-runs/  AutoNote：按次技能执行的临时材料
├── files/           AutoNote 附件
└── logs/            Aether observability 日志
```

规则：

- `library.db` 不增加 Aether 表；
- `providers.db` 不增加 AutoNote note 表；
- `chat.db` 不保存明文 key、笔记正文快照或任意完整文件路径；
- `mcp-server.db` 只保存 token hash，不保存 bearer token；
- 用户第一次启动新版本时重新配置 provider 和角色；
- 不读取旧 `ai_*` 表，不尝试旧密文解密，不导入旧对话。

### 4.2 Provider 与角色

Aether `aether-providers` 负责：

```text
Provider
  └── Endpoint
        └── Model
```

AutoNote 负责一个很小的产品配置层：

```text
AiRoleBinding {
  role: "chat" | "writing",
  model: ModelRef | null,
  isFallback: boolean
}
```

建议角色规则：

- `chat` 未绑定：AI 对话入口显示未配置；
- `writing` 未绑定且 `chat` 已绑定：沿用 `chat`，`isFallback=true`；
- `writing` 已绑定：使用独立模型；
- 只能绑定 `ModelType::Chat`；
- binding 存在于 AutoNote 产品设置中，不修改 Aether provider schema；
- `chat` 与 `writing` 可以使用同一模型，但每次运行的 `purpose` 不同。

推荐保存位置：AutoNote 自己的产品设置表/命名空间，而不是修改 Aether `providers.db`。Aether 只接受运行时传入的 `ModelRef`。

---

## 5. 笔记页 AI 对话与 `noteId`

### 5.1 不把 noteId 放进 Aether 通用 DTO

Aether 的 `RunRequest.context` 已经是宿主定义的引用：

```rust
pub struct ContextRef {
    pub kind: String,
    pub id: String,
}
```

AutoNote 使用：

```json
{
  "kind": "autonote-note",
  "id": "<26-char-note-id>"
}
```

`RunRequest.purpose` 使用：

```text
chat
```

`RunRequest.scope` 使用：

```text
note:<noteId>
```

这三层含义不同：

| 字段      | 用途                                       |
| --------- | ------------------------------------------ |
| `purpose` | 选择产品运行语义和角色，`chat` / `writing` |
| `context` | 宿主从哪个领域对象加载上下文               |
| `scope`   | 会话隔离、历史和 UI 绑定范围               |

### 5.2 Chat 运行流程

```text
用户在 noteId=N 的笔记页发送消息
        │
        ▼
ChatSession 读取当前 conversationId
        │
        ▼
AutoNote HostAdapter 校验 noteId 仍存在且未删除
        │
        ▼
从 note-core 读取当前标题、正文、必要上下文
        │
        ▼
构造 RunRequest
  purpose = chat
  context = { kind: autonote-note, id: N }
  scope = note:N
  conversationId = 当前会话或 null
        │
        ▼
tauri-plugin-aether::chat_run
        │
        ▼
Aether resolve ModelRef → Connection
        │
        ▼
Aether chat 流式返回 RunEvent
```

### 5.3 上下文策略

默认不把整本笔记库塞进 prompt。一次对话只注入：

```text
当前笔记标题
当前笔记正文（有界截断）
用户明确选中的文本（如果有）
AutoNote 固定产品 system prompt
```

如果需要跨笔记信息，使用 AutoNote 提供的只读工具：

```text
search_notes
read_note
get_note_context
list_folders
list_tags
```

这样比把整个库拼进 system 更安全、更省 token，也更容易审计。

### 5.4 会话规则

- `scope=note:<noteId>`；
- 删除笔记后，不能继续向该 scope 发起新运行；
- 删除笔记不强制删除 chat.db 中的历史，产品可以后续提供清理功能；
- 新建笔记没有 conversationId；
- 重新生成使用 Aether `regenerate=true`；
- ChatPanel 不直接读取 SQLite；
- 所有历史通过 Aether `chat_*` 命令读取。

---

## 6. Writing 角色与编辑器上下文

### 6.1 角色保持独立

`writing` 不是另一个聊天协议，也不是另一个模型客户端。它只是不同的产品任务：

```text
purpose = writing
role = writing
scope = note:<noteId>:writing
```

角色选择：

```text
writing binding → 使用 writing 模型
writing 未绑定 → 使用 chat 模型，isFallback=true
```

### 6.2 写作请求合同

AutoNote UI 到宿主的产品请求：

```ts
interface WritingRequest {
  noteId: string
  action: 'polish' | 'rewrite' | 'shorten' | 'expand' | 'continue'
  selectedText: string
  beforeText: string
  afterText: string
  cursorOffset: number
  language: 'zh-CN' | 'en-US'
  title: string
}
```

限制：

- `selectedText` ≤ 24,000 字符；
- `beforeText`、`afterText` 各自有上限；
- 总请求字节数有明确上限；
- `cursorOffset` 必须对应发送时的编辑器快照；
- 绝不把整个 `Note` 对象直接序列化给 UI 或模型。

### 6.3 Aether 运行映射

```text
RunRequest.purpose = "writing"
RunRequest.context = { kind: "autonote-note", id: noteId }
RunRequest.scope = "note:<noteId>:writing"
RunRequest.input = 固定动作提示词 + selectedText
RunRequest.skills = []
RunRequest.permissionMode = "default"
```

`purpose=writing` 固定 Default，不继承聊天权限模式；不带技能，也不提供 `skill_run`。宿主的 `mcp_tools(req)` 对 writing 返回 `false`：既不启动 HTTP/stdio MCP 会话，也不向模型列出 MCP 工具。写作始终只是生成候选文本，再由 §6.4 的编辑器安全门写回。

AutoNote HostAdapter 的 `system_prompt` 组装：

```text
固定 writing system prompt
动作说明
当前语言
笔记标题
beforeText / afterText 作为上下文
selectedText 作为待处理文本
输出规则：只返回可插入正文，不返回解释、Markdown fence 或前后缀
```

Aether 只负责：

- 选择模型；
- 发送 system/input；
- 流式事件；
- 取消；
- 错误和生命周期。

### 6.4 写回安全门

写作结果不能直接覆盖当前编辑器。前端必须保存：

```text
requestId
noteId
editorGeneration
sourceTextHash
selectionStart
selectionEnd
```

流式结果完成后：

1. 检查当前 noteId 未变化；
2. 检查 editorGeneration 未变化；
3. 检查选区前后的源文快照仍匹配；
4. 不匹配则拒绝自动替换，保留结果供复制；
5. 匹配则允许：替换选区、插入光标或复制；
6. 写回通过 AutoNote `notes.patch`，使用当前本地 rev；
7. rev 冲突返回 conflict，绝不静默覆盖新编辑。

### 6.5 更优雅的统一方式

不建议给 Aether 增加 `WritingRequest`。更简洁的边界是：

```text
AutoNote WritingController
    ↓ 组装 WritingRequest
AutoNote HostAdapter
    ↓ 转换为 RunRequest
Aether chat_run
    ↓ RunEvent
AutoNote WritingController
    ↓ 版本/快照安全门
Editor
```

这样 Aether 不需要理解：

- 笔记；
- 选区；
- 光标；
- Markdown；
- writing 动作；
- 编辑器版本。

未来其他宿主也可以把自己的写作、邮件、代码编辑请求映射到同一个 Aether `chat_run`。

---

## 7. AutoNote HostAdapter 设计

### 7.1 `KitHost` 实现

AutoNote 实现 `tauri_plugin_aether::KitHost`：

```rust
struct AutoNoteHost {
    library: Arc<note_core::Library>,
    roles: Arc<AutoNoteRoleStore>,
    tools: Arc<AutoNoteToolRegistry>,
}
```

职责：

| 方法               | AutoNote 行为                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `select_model`     | 根据 `purpose` 选择 `chat` 或 `writing` role；显式 `model` 优先，但必须属于已配置模型                                                         |
| `system_prompt`    | 生成 chat/writing 固定 system prompt                                                                                                          |
| `context`          | 根据 `ContextRef` 读取 note-core 当前笔记，返回有界 ContextBlock                                                                              |
| `tools`            | chat 仅在本次选中的固定修订技能含脚本时提供 `skill_run`（`effect=Exec`）；writing 不提供工具；本文 §8.1–§8.2 的领域目录不因本次接入自动启用   |
| `call_tool`        | `skill_run` 仅运行所选技能快照中的脚本，执行约束见 §8.5；领域操作仍须走 note-core，不直接 SQL                                                 |
| `permission_modes` | chat 显式允许全部五种模式；writing 只允许 Default                                                                                             |
| `mcp_tools`        | writing 返回 false，其余聊天运行允许按配置建立 MCP Client 会话                                                                                |
| `authorize`        | 使用 `AuthorizeContext { mode, purpose, run_id, effect, source, proposed }` 作同步、纯内存的最终裁决；`skill_run` 规则见 §7.4，不能在此做 I/O |

### 7.2 模型选择优先级

```text
显式 RunRequest.model
    ↓ 无或无效
purpose=writing → writing binding
purpose=chat → chat binding
    ↓ writing 未绑定
chat binding，isFallback=true
    ↓ 仍无绑定
needs_config{reason:model_not_configured}
```

显式 `model` 不能绕过 provider store 和角色限制。它只能选择已保存且可解析的模型。

### 7.3 Context 读取

`context()` 只读 `note-core` 的公开领域 API：

```text
kind=autonote-note
id=noteId
```

返回：

```text
source = "AutoNote note: <title>"
text = 有界的标题 + 正文摘要/正文
```

不存在、已删除或超限时返回结构化错误，不返回空白上下文冒充成功。

### 7.4 按次运行的五种权限模式

`RunRequest.permissionMode` 可省略，缺省为 `default`。宿主通过 `KitHost::permission_modes` 声明允许列表；未允许的请求模式在受理时以 `bad_request{field:"permission_mode", reason:"not_allowed"}` 拒绝。模式在运行开始时固定，模型、技能正文与工具结果都不能在运行中改变它。

| 模式                                        | 工具目录与审批语义                                                                                        | `skill_run`                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Default（逐次确认，`default`）              | 保留目录，沿用各工具原有审批配置；并非所有只读工具都需要确认                                              | Ask                                     |
| Plan（仅规划，`plan`）                      | 只向模型提供 `effect=Read` 的工具，保留其原审批；界面显示仅规划标记，需要执行时由用户在下一次运行切换模式 | 不提供（Exec）                          |
| AcceptEdits（自动接受编辑，`accept_edits`） | 仅将 Edit 工具的 Ask 改为 Auto，执行与其他效果不变                                                        | Ask（Exec 不属于 Edit）                 |
| Auto（智能批准，`auto`）                    | 宿主工具的 Ask 可自动批准，再由宿主风险规则改回 Ask；MCP 维持原审批                                       | `script_risk` 未命中时 Auto，命中时 Ask |
| FullAccess（完全访问，`full_access`）       | 包括 MCP 在内的 Ask 改为 Auto，仍受宿主最终裁决约束                                                       | Auto                                    |

任何模式都不能把工具自身的 Deny 放宽；MCP 工具统一声明 `effect=Other`，不能根据不可信的 `readOnlyHint` 把它们纳入 Plan 或自动接受编辑。`authorize` 的返回值是最终裁决，宿主仍可将 Auto 改回 Ask 或 Deny。

聊天包装层向 Aether `ChatPanel` 传宿主允许列表（当前公开 prop 为 `permissionModes`），通过可绑定的 `permissionMode` 传递下一次运行选择。**FullAccess 必须由用户为本次运行显式选择，并在每次启动前完成交互式危险确认**；不能仅依赖曾经选中过该模式时的确认。它不保存为偏好或默认值，不从会话/历史恢复，也不被发送、重试、重新生成等后续运行自动复用；取消确认不启动运行。普通模式的偏好保存不能间接持久化 FullAccess。writing 只发送 Default，不显示可提升权限的选择。

Auto 的 `aether_chat::risk::script_risk` 检查只是在常见危险脚本前减少误操作、增加确认的**便利性护栏，不是安全边界**；未命中不等于脚本安全。FullAccess 也不是越过操作系统权限或解除所有安全约束的许可。

---

## 8. AutoNote 工具目录

### 8.1 Chat 默认工具

```text
read_note       Auto
search_notes    Auto
get_note_context Auto
list_folders    Auto
list_tags       Auto
```

### 8.2 Chat 写工具

默认 `Ask`：

```text
create_note
update_note
trash_note
restore_note
update_note_properties
upload_attachment
```

所有写工具必须：

- 接受 `expected_rev`；
- 走 `note-core` CAS；
- 使用 `WriteOrigin::Mcp` 或宿主明确的 AI origin；
- 单事务完成领域变更；
- 通过 ChangeSink 通知 UI；
- 失败不产生部分写入。

### 8.3 Writing 默认工具

Writing 不提供工具，不带技能，权限固定 Default，也不启动或列出 MCP 工具。Writing 是“生成候选文本 → 前端安全写回”，而不是让模型直接修改笔记；不提供 `update_note` 或 `skill_run` 绕过选区安全门。

### 8.4 MCP 工具来源

AutoNote 自己的工具注册为 `ToolSource::Host`。外部 MCP 工具由 Aether `mcp-client` 接入，注册为 `ToolSource::Mcp`，和宿主工具进入同一个 Aether 工具目录及审批流程，但不把 MCP 的只读提示视为可信权限声明。MCP Client 支持 HTTP（Streamable HTTP）和 stdio；它与面向外部客户端的 AutoNote 本地 MCP Server 是两个独立方向。设置、启用与信任由用户明确配置，不能因为模型请求某个工具就自动信任或启动新服务。writing 完全排除 MCP 会话。

### 8.5 所选技能脚本执行：`skill_run`

`skill_run` 是 `ToolSource::Host`、`ToolEffect::Exec` 的窄入口，不是通用 shell 或文件操作工具。只在本次 chat 运行明确选中的技能含可执行脚本时注册；不得接受模型提供的任意脚本正文、宿主绝对路径或未选中的技能，也不另行开放任意 shell、文件读写工具。

宿主独立打开与插件相同数据根的 skills Store，以本次所选技能的 `{id, revision}` 读取全部文件并固定执行快照。脚本只能从该固定快照中选择，不能执行当前最新修订、重新导入版本或后来替换的文件。技能已删除或修订变化时按 `skill_changed` 冲突失败，不能悄悄改用新版本。

执行流程与限制：

1. 将已读取的完整技能快照临时落到 `data_dir/staging/skill-runs/<uuid>/`；拒绝逃逸路径，脚本入口必须属于该快照。
2. 按脚本扩展名选择受支持的解释器，以该临时目录为 cwd。解释器必须在用户系统上实际可用；不让模型指定任意解释器或命令字符串。
3. 清空继承环境，只保留运行所需的非敏感环境；过滤密钥、token、密码、凭据等敏感变量，不向子进程注入 provider/MCP 凭据。环境过滤不是文件或网络隔离。
4. 超时默认 **120 秒**，最多 **1800 秒**；stdout 与 stderr 分别最多保留 **64 KiB**，超出后截断但继续排空管道，不能因输出达到上限而死锁。
5. 取消、超时及运行结束时清理**完整进程树**，包括根进程先退出后仍存活的后代。使用固定依赖 `process-wrap = "=10.0.1"`（关闭 default features，开启 `tokio1`、`job-object`、`process-group`、`kill-on-drop`、`creation-flags`）：Windows 用 kill-on-close Job Object，Unix 用进程组；不依赖外部 `taskkill`/`kill` 命令，也不在根进程已退出时跳过后代清理。
6. 进程树结束后删除该次临时目录，不将物化目录复用为下次运行或技能源；取消与失败同样进入清理流程。

**这不是沙箱。脚本以当前用户的真实操作系统权限执行，可以访问该用户可访问的文件系统与网络。cwd 只是工作目录，不是文件访问边界；临时物化、路径校验、输出截断、敏感环境过滤和风险规则都不会把脚本限制在临时目录内。** 用户应先审阅技能及脚本，只运行信任的来源；Default/AcceptEdits 的逐次审批与 FullAccess 的按次危险确认必须明确保留这一风险含义。

---

## 9. Aether 接入方式

### 9.1 固定依赖与功能开关

AutoNote `desktop/src-tauri/Cargo.toml` 依赖：

```toml
aether-observability = { git = "https://github.com/ouraihub/Aether.git", rev = "<fixed-commit>" }
aether-providers = { git = "https://github.com/ouraihub/Aether.git", rev = "<fixed-commit>" }
aether-chat = { git = "https://github.com/ouraihub/Aether.git", rev = "<fixed-commit>" }
aether-mcp-server = { git = "https://github.com/ouraihub/Aether.git", rev = "<fixed-commit>" }
aether-skills = { git = "https://github.com/ouraihub/Aether.git", rev = "<fixed-commit>" }
aether-mcp-client = { git = "https://github.com/ouraihub/Aether.git", rev = "<fixed-commit>" }
tauri-plugin-aether = { git = "https://github.com/ouraihub/Aether.git", rev = "<fixed-commit>", features = ["providers", "chat", "mcp-server", "skills", "mcp-client"] }
```

实际 Cargo 依赖名是 `tauri-plugin-aether`；代码中的 Rust import 名为 `tauri_plugin_aether`。上面的依赖声明只展示接入方向，`aether-support` 等私有依赖由各 Aether crate 的传递依赖解决。

上述为依赖方向示意，原有 search 等功能开关须保留。实际固定 SHA 由父集成人在 Aether 合并后统一更新（§3.1），本接入不改为本地依赖。

### 9.2 Builder 装配

```rust
let root = autonote_shell::paths::data_dir()?;
let logs = aether_observability::init(
    &root.join("logs"),
    LogConfig::default(),
    None,
)?;
let library = Arc::new(note_core::Library::open(&root, deps)?);
let host = Arc::new(AutoNoteHost::new(library.clone(), roles, tools));

let builder = tauri_plugin_aether::Builder::new(host, logs)
    .providers(aether_providers::Store::open(&root)?)
    .chat(tauri_plugin_aether::ChatConfig::default(), Some(chat_store))
    .skills(aether_skills::Store::open(&root, &[])?)
    .mcp_client(aether_mcp_client::Store::open(&root)?)
    .mcp_server(mcp_server);
```

实际实现必须使用真实公开 API；本段是装配目标，不是当前可复制代码。若 Aether 的 `Builder` 只暴露 `tauri_plugin_aether::Builder`，不得额外建立第二个 facade。

宿主另开同数据根的 skills Store，用于 §8.5 的固定修订读取；不能拿最新配置替代运行选中快照。`capabilities/default.json` 增加 `aether:skills`、`aether:mcp-client`，桌面端 `createTauriPorts` 打开 `skills: true`、`mcpClient: true`。共享设置按 `kit.skills`/`kit.mcpClient` 是否存在挂载 `SkillsSettings`/`McpClientSettings`，无端口不显示分区；ChatPanel 通过 skills 端口内置选择器提交本次 `{id, revision}`。MCP Client 设置允许分别配置 HTTP 服务与 stdio 命令/参数、显式信任和启用；stdio 启动的是用户权限下的本地进程，需同样谨慎对待来源和环境。现有本地 MCP Server 设置不挪为 Client，也不改变其 token/scope 权限。

### 9.3 数据目录

AutoNote 继续使用 exe 同级 `data` 决策，不调用 Aether 的 `data_root` 作为最终根目录。Aether 各 Store 接收 AutoNote 传入的同一个 root：

```text
<exe>/data/library.db
<exe>/data/providers.db
<exe>/data/chat.db
<exe>/data/mcp-server.db
<exe>/data/skills.db
<exe>/data/mcp-client.db
<exe>/data/staging/skill-runs/<uuid>/
<exe>/data/logs/
```

这样符合 AutoNote D8，并避免框架自行回退到 AppData。

### 9.4 日志

第一阶段把 AutoNote `shell::logging::init` 替换为 Aether observability，但保留 AutoNote 的日志事件名和 LogPanel。日志中禁止：

- provider key；
- Authorization header；
- note 正文；
- 选区正文；
- SQL；
- 绝对路径；
- 上游原始错误正文。

---

## 10. 实施阶段与文件所有权

### A0：分支和依赖基线

拥有文件：

```text
desktop/src-tauri/Cargo.toml
desktop/src-tauri/Cargo.lock
desktop/src-tauri/src/lib.rs
```

步骤：

1. 建 `refactor/use-aether`；
2. 固定 Aether Git commit；
3. 不改变 AutoNote 行为；
4. `cargo metadata --locked`、workspace check；
5. 记录当前基线。

完成判据：AutoNote 原有检查仍通过，Aether 依赖可锁定。

### A1：Observability

拥有文件：

```text
desktop/src-tauri/shell/src/logging.rs
desktop/src-tauri/shell/src/logs.rs
desktop/src-tauri/src/lib.rs
desktop/src/lib/log/*
```

步骤：

1. 在 Builder 前初始化 Aether LogHandle；
2. 替换写盘、轮转、tail；
3. 保留 AutoNote UI；
4. 验证前端 ingest、日志级别、重启读回；
5. 扫描日志和数据库无密钥。

禁止：同时注册旧 writer 和 Aether writer。

### A2：Provider / Role

拥有文件：

```text
desktop/src-tauri/core/src/ai.rs
```

建议动作：

1. 删除 AutoNote provider/endpoint/model 的 SQL 读写；
2. `AutoNoteRoleStore` 只保存 `chat` / `writing` 的 ModelRef；
3. 通过 Aether `aether-providers::Store` 读 provider/model；
4. 设置 UI 改为调用 Aether provider commands；
5. 角色绑定只在 AutoNote 命令层保存；
6. 不保留旧 `ai_*` schema。

完成判据：新数据目录能重新配置 provider、模型列表和两个角色；支持 writing fallback。

### A3：Chat

拥有文件：

```text
desktop/src-tauri/ai/src/chat.rs
desktop/src-tauri/core/src/ai.rs
desktop/src-tauri/src/commands/ai.rs
desktop/src/lib/ports/ai.ts
desktop/src/lib/ai/chat-session.svelte.ts
```

建议动作：

1. 删除 AutoNote 自己的三协议请求和 SSE decoder；
2. `ai_chat` 改为 `chat_run` 或保留 AutoNote 命令名作为薄产品适配；
3. Request 映射到 Aether `RunRequest`；
4. AutoNote HostAdapter 提供 note context、role、tools；
5. Aether RunEvent 映射为 AutoNote `AiWriteEvent` / ChatEvent；
6. 会话历史由 Aether chat store 负责；
7. AutoNote ChatSession 只保留 UI 状态，不保存第二份消息历史。

不建议直接让 AutoNote UI 依赖 Aether DTO。保持 `AiPort` 产品端口，Tauri adapter 负责转换。

### A4：Writing

拥有文件：

```text
desktop/src-tauri/src/commands/ai.rs
desktop/src/lib/ai/WritingToolbar.svelte
desktop/src/lib/ipc/transport.ts
packages/app/src/features/ai/*
```

步骤：

1. 保留 `AiWriteAction`；
2. 保留选区/光标/前后文快照；
3. writing 请求转 Aether `purpose=writing`；
4. 结果不自动写库；
5. 通过 editor generation + source hash 安全门；
6. 通过 `notes.patch` CAS 写回；
7. 保留停止、替换、插入、复制。

### A5：MCP Server

拥有文件：

```text
desktop/src-tauri/mcp
desktop/src-tauri/core/src/mcp*.rs
desktop/src-tauri/src/commands/mcp.rs
desktop/src/lib/ipc/ports/mcp.ts
```

步骤：

1. 使用 Aether MCP server transport/auth/scope；
2. AutoNote 保留工具 schema、读取和写入实现；
3. `ToolExecutor` 或 HostTool 调 note-core；
4. 写操作仍由 AutoNote operation idempotency 保证；
5. 端口、token、scope 由 Aether 管理；
6. 真实 MCP Inspector 和 Claude Code 联验；
7. 通过后删除 `note-mcp` 传输层，不删除 note-core 工具。

### A6：清理

只有 A1–A5 全部真实验收后才能删除：

```text
note-ai 的 HTTP/SSE/decoder
note-mcp 的 transport/auth 重复实现
旧 shell logging writer
旧 provider/AI SQL API
旧 AI chat history API
```

---

## 11. 验收矩阵

### 11.1 Aether 框架验收

```text
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm run check
pnpm kit:dto-check
pnpm kit:i18n
node scripts/check-deps.mjs
```

### 11.2 AutoNote 宿主验收

```text
pnpm run app:check
pnpm run web:check
pnpm run web:test
pnpm run desktop:verify
```

### 11.3 Provider / Role

- 新建 provider；
- 获取模型；
- 绑定 chat；
- 绑定 writing；
- writing 未绑定时 fallback 到 chat；
- 重启后配置仍在；
- key 不出现在日志、数据库明文和 IPC 返回；
- 不支持的模型不能绑定角色。

### 11.4 Chat

- 当前 noteId 对话；
- 新建会话；
- 继续会话；
- 重启读回；
- 三协议纯文本；
- 首包/空闲超时；
- 停止；
- 关闭窗口取消；
- 删除笔记后不能继续运行；
- 旧正文不被作为新上下文误读。

### 11.5 Writing

- 五种 action；
- 无选区 Continue；
- 有选区 Rewrite/Polish；
- 前后文注入；
- 流式预览；
- Stop；
- Replace；
- Insert；
- Copy；
- 编辑器变化后拒绝自动写回；
- note rev 冲突保留结果，不覆盖新内容。

### 11.6 MCP

- 只读工具无审批或按默认策略执行；
- 写工具 Ask；
- 拒绝写操作；
- 取消审批；
- token revoke；
- scope 过滤；
- 非回环和非法 Origin 拒绝；
- operationId 重放幂等；
- 写操作经过 note-core 单事务；
- 外部 MCP client 能连接并调用。

### 11.7 崩溃恢复

每阶段至少验证：

- 运行中关闭窗口；
- 流式中取消；
- DB 提交前失败；
- 写工具执行失败；
- MCP 服务端口占用；
- 重启后 provider/role/chat/log 状态正确；
- 无残留后台任务；
- 无密钥或笔记正文进入日志。

---

## 12. 中断恢复协议

如果实施中断，下一次执行者按以下顺序恢复，不凭聊天记录猜状态：

1. 读取本文件；
2. 读取 AutoNote `docs/03-开发任务清单.md` 当前状态；
3. 运行：

```text
git status --short
git branch --show-current
git log -5 --oneline
```

4. 读取当前阶段最近一次提交；
5. 检查以下文件是否存在并能编译：

```text
desktop/src-tauri/Cargo.toml
desktop/src-tauri/src/lib.rs
desktop/src-tauri/src/commands/ai.rs
desktop/src-tauri/core/src/ai.rs
desktop/src-tauri/ai/
desktop/src-tauri/mcp/
```

6. 只领取当前任务依赖全部完成且没有其他执行者持有的文件；
7. 先跑所属模块最小检查；
8. 完成真实场景后再勾任务；
9. 不用兼容 shim 掩盖 Aether 与 AutoNote 合同冲突；
10. 不迁移旧数据，不读取旧密文，不为了历史兼容扩大设计。

每阶段提交必须在提交说明中写：

```text
任务号
变更文件
验证命令和退出结果
真实场景
未验证项
下一阶段依赖
```

---

## 13. 当前建议

第一步只做 A0：分支、固定 Aether commit、依赖基线和回归门禁。

不要一开始迁移 AI、MCP、数据库和 UI。先让 AutoNote 在 Aether 依赖存在时仍然可构建，然后按：

```text
A0 → A1 logging → A2 providers/role → A3 chat → A4 writing → A5 MCP → A6 cleanup
```

推进。

R6-1 的推荐版文档核对属于 Aether 自身发布工作，不阻塞 AutoNote 分支建立；AutoNote 迁移只依赖 Aether 已发布且稳定的公开 API。

## 14. 技能脚本、MCP Client 与权限模式接入（2026-10-27）

- Aether Rust、桌面／共享应用／Web 的 UI 依赖统一固定到已合并修订 `855c55bc2eb23c162323c9bfe29c2d9f8e430b9e`。权限与菜单分别经 Aether PR #9、#10，四项必需检查通过；该主分支修订的三平台 CI 也通过。
- AutoNote 开启 skills 与 mcp-client，新增独立设置分区；技能脚本固定本 run 的 revision、文件字节与批准参数。默认／自动接受编辑仍需脚本审批；智能批准依规则；完全访问只消费一次，不保存为默认。写作不载入技能或外部 MCP。
- 完整 `pnpm run ci` 通过，包括 Web 检查／测试／构建、桌面类型与 Rust workspace 测试、原生密钥检查、Clippy、格式与实际 Windows NSIS／portable 构建。未执行 macOS／Linux AutoNote 原生窗口验收、NSIS 安装卸载和付费模型联验。
- 隔离正式桌面程序实测：真实文件选择导入含 `scripts/run.js` 的 ZIP，预览显示脚本与文件清单，安装成功；聊天中的 `skill_run` 显示带 revision、路径和完整参数的批准卡片，点击“允许本次”后返回 `AUTONOTE_APPROVED_SCRIPT_OK`，运行临时目录清空。测试使用本地回环模型服务，不修改用户模型、笔记和凭据。
- 同一桌面设置里保存本地 stdio filesystem 服务，测试连接发现 14 个工具。命令直接为 `npx`，参数包括固定版本 `@modelcontextprotocol/server-filesystem@2.0.1` 和隔离允许目录；服务保持未启用／未信任，不自动提供给聊天。
- 原有思考强度滑杆保留：正式 WebView2 选择“高”后实际请求包含 `reasoning_effort: high`；恢复默认后实际请求省略该字段。权限菜单使用五个独立图标、黄色信息提示、红色危险项、固定状态列与选中背景，正式 AutoNote 窗口已观察，不以 Aether 示例代替宿主验收。
- 脚本以用户权限执行，工作目录、规则扫描与环境过滤均不是操作系统沙箱；不能保证其不访问工作区外文件或网络。此限制在设置、聊天和批准输入中明确显示。
- Linux 退出回归修正：`kill -0` 会把已经终止、等待 init 回收的 `Z` 进程误报为存活。测试改用 `ps stat` 区分，并有界等待信号生效；新增真实活进程必须拒绝、杀死但未回收必须接受的边界。生产进程组清理不变。WSL2 直接引用原 `skill_process.rs` 的临时小 crate 验证全部 7 项进程测试通过；另用 subreaper 保留孤儿僵尸，实测 `Z` 状态且全部 7 项通过。WSL 缺 GTK/WebKitGTK，未编译完整 Tauri 应用，不能冒充 Linux 打包／窗口通过。
- `skill_run` 宿主终裁首先保留 `ctx.proposed == Deny`，在任何权限模式下都不得改为 Ask／Auto，也不登记可执行调用。新增 Default／Plan／AcceptEdits／Auto／FullAccess 五模式拒绝回归：修复前 Default 实测错误返回 Ask；修复后拒绝并且执行入口返回 `not_allowed`。
