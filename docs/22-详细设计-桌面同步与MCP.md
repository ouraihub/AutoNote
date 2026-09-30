# 22 详细设计：桌面同步与 MCP

> 状态：阶段设计基线；本文件只描述 D4（本地 MCP 服务）和 D5（同步到 Web 实例），不代表代码已经完成。
> 契约来源：`02-概要设计.md`（§3 端口、§4 类型、§5 错误码、§6 ChangeFeed、§7 写入语义、§8 IPC）；工程写法来源：`04-工程规范.md`。
> 引用约定：`20 §x` 指 `20-详细设计-桌面内核.md`，`21 §x` 指 `21-详细设计-桌面宿主.md`，`10 §x` 指 `10-详细设计-共享应用层.md`。所有路径以 AutoPad 仓库根为准。

## 1. 结论与边界

### 1.1 MCP 采用维护的 Rust SDK

本地 MCP 服务采用维护中的 Rust SDK **`rmcp`**，不再手写最小 MCP 协议，也不以“少引入几个 crate”为选型依据。`rmcp` 负责 JSON-RPC 消息、初始化协商、工具列表/调用、通知、协议错误和选定的 HTTP/streamable-http 传输；`note-mcp` 只负责鉴权、工具契约、权限、调用 `note-core` 以及把领域错误映射为 MCP 错误。

`rmcp` 的确切版本不能凭记忆填写。D4-1 必须在目标锁定的 Rust toolchain、目标平台和当前 Cargo registry 上实际执行 `cargo add`/`cargo metadata`，确认 SDK 的 server API、streamable HTTP feature、依赖许可和 MSRV；随后把解析出的**确切版本**写入对应 `Cargo.toml` 与 `Cargo.lock`。D4-1 的验收必须包含该命令输出和真实客户端握手、`tools/list`、`tools/call` 结果。没有这些证据不得声称 SDK 版本已验证，也不得退回手写协议。

协议服务只提供本地知识库，不是调用外部 MCP 的客户端；不代理外部工具、不把外部 MCP 凭据存入本地库。监听地址默认 `127.0.0.1`，不得绑定局域网地址。原始 token 只在创建时显示一次，数据库只保存哈希。

### 1.2 34 个工具的冻结清单

桌面 MCP 暴露恰好以下 34 个工具，名称、参数名和结果语义与 Web MCP 的知识库工具保持一致；实现中以共享 DTO 和工具契约夹具防止漂移。云端备份、公开分享及账户管理不是本地知识库操作，不纳入桌面 34 工具，不因 Web 端存在对应能力而暴露。

| 组 | 工具 | 数量 |
| --- | --- | ---: |
| 检索 | `search`、`fetch`、`search_notes`、`list_notes`、`read_note`、`get_note_context`、`list_folders`、`list_tags` | 8 |
| 笔记写入/历史 | `create_note`、`edit_note`、`organize_note`、`trash_note`、`restore_note`、`duplicate_note`、`list_note_versions`、`read_note_version`、`restore_note_version` | 9 |
| 文件夹/标签 | `create_folder`、`update_folder`、`create_tag`、`update_tag`、`preview_tag_change`、`delete_tag`、`preview_folder_removal`、`remove_folder_and_promote_contents`、`bulk_organize_notes` | 9 |
| 附件 | `list_attachments`、`read_attachment`、`upload_attachment`、`delete_attachment` | 4 |
| 属性 | `get_note_properties`、`update_note_properties`、`query_note_properties` | 3 |
| 图谱 | `explore_note_graph` | 1 |
| **合计** |  | **34** |

每个工具的参数以 `web/src/worker/mcp/server.ts` 的 zod schema 为权威；桌面通过导出的夹具生成同样的 JSON Schema，不自行添加或删除任何字段。写工具中只有实际 schema 声明的 `operation_id` 才参与 MCP 幂等。所有笔记正文和属性修改使用 `expected_rev`；文件夹/标签等字段没有远端 CAS 时，桌面 MCP 不把本地时间戳伪装成强一致 CAS。Ui/MCP 的过期版本只返回 `conflict`，绝不静默 rebase；只有 D5 的远端回放允许按 §7 的规则保留双方版本。

桌面 `note-core` 是单库单用户，`mcp_operations` 没有 `user_id`。幂等键是 `operation_id`；tool 和 request_hash 必须在同一事务中比较，工具名或请求体不同即 `conflict`。

### 1.3 同步不修改服务端

D5仅调用现有HTTP/WS接口，不改Worker或服务端schema。metadata REST无CAS的竞态按§7.4处理，不能借MCP的expected_updated_at参数宣称REST有同样保护。

### 1.4 统一事务与事件边界

MCP 写操作必须由 `note-core` 在**一个 SQLite transaction** 中完成：查幂等记录、校验请求哈希、读取/检查版本、修改领域数据及索引、写 `mcp_operations` 并保存完整结果，最后一次提交。禁止 MCP 层先开一个事务查 `mcp_operations`、再让 Library 开第二个事务写入；禁止“业务已提交但幂等结果未提交”或相反的两阶段实现。提交后释放数据库锁，再发 `autonote://library-changed`，不在事务内发事件。

文件系统附件不能假定和 SQLite 同一事务。附件采用临时文件、fsync、原子 rename、数据库引用保护和启动恢复扫描；未被已提交记录引用的临时文件可清理，已被记录引用的正式文件不得误删。

## 2. 范围、依赖与模块布局

### 2.1 本文负责

| 范围 | 职责 |
| --- | --- |
| `desktop/src-tauri/mcp/` | rmcp server 装配、认证、34 工具适配、schema、结果和调用限制 |
| `desktop/src-tauri/core/src/store/mcp.rs`、`query/mcp.rs` | MCP 操作幂等记录、MCP 专用只读查询和领域结果 |
| `desktop/src-tauri/sync/` | 会话、绑定、pull/push、附件传输副本、实时通知和串行调度 |
| `desktop/src-tauri/core/src/store/sync.rs` | D5 的迁移、绑定/映射/outbox 状态读写 |
| `desktop/src-tauri/shell/src/credentials/` | Windows DPAPI protect/unprotect；失败不得明文降级 |
| `desktop/src-tauri/src/commands/{mcp,sync}.rs`、`src/services/{mcp,sync}.rs` | Tauri command 转发、事件和服务组合根 |
| `desktop/src/lib/ipc/ports/{mcp,sync}.ts`、设置分区 | 前端端口和 MCP/同步设置显示 |
| `desktop/fixtures/mcp-tools.json` | 34 工具的参数/结果/注解契约夹具 |

不做分享、备份、语义搜索、OAuth、多账号和远端 settings/profile 同步。桌面使用本地固定用户；同步绑定一个 Web 实例账户，切换绑定必须显式执行重绑定流程。

### 2.2 依赖

- `20`：`Library` 的 `create_note`、`patch_note`、组织/删除/恢复、版本、附件和查询 API；`WriteOrigin::{Ui,Mcp,Sync,Import}`；`ChangeSink`；迁移 v2；`WriteTx`；`app_log` 和 command 总表。
- `21`：`IpcTransport`、组合根、`IpcBackendOptions.mcp/remoteSync`、`desktopSettingsSections()`、托盘订阅事件。
- `10`：`McpPort`/`McpLocalPort`、共享 DTO、`BackendError` 及 ChangeFeed。
- D1-2 的核心 schema、D1-4～D1-7 的本地领域写入/文件查询、D2-1 的 IPC transport、D2-5 的设置注册和 D2-6 的脱敏日志。

### 2.3 目录

```text
desktop/src-tauri/
├── core/src/store/{mcp,sync}.rs       # 只能由 core 执行 SQL 和事务
├── core/src/query/mcp.rs              # 34 工具的只读查询与边界限制
├── shell/src/credentials/             # DPAPI；唯一允许 unsafe FFI 的模块
├── mcp/src/
│   ├── lib.rs                         # McpServer、McpConfig、TokenStore、StatusSink
│   ├── transport.rs                   # rmcp server/streamable-http 装配
│   ├── auth.rs                        # token 哈希、scope、来源校验和限流
│   ├── schema.rs                      # 工具 schema/结果契约
│   └── tools/{read,write,organize,attachments,properties}.rs
├── sync/src/
│   ├── lib.rs                         # SyncService、RemoteApi、SecretStore、SyncStatus
│   ├── remote.rs                      # HTTP/WS RemoteApi；不改服务端
│   ├── session.rs                     # cookie 解析、域/path/过期/重定向策略
│   ├── bind.rs                        # 首次绑定和 epoch 隔离
│   ├── pull.rs、push.rs               # 游标分页、outbox 回放和冲突副本
│   ├── attachments.rs                  # 仅操作传输副本的 ID 映射
│   ├── realtime.rs                    # WS、心跳、退避、轮询降级
│   └── engine.rs                      # 单任务串行调度
├── src/commands/{mcp,sync}.rs         # Tauri command 仅转发
└── src/services/{mcp,sync}.rs         # 组合根实现状态与事件

desktop/fixtures/mcp-tools.json
web/scripts/export-mcp-tools.mjs       # 只读取 Web MCP 定义，不改 Worker
```

### 2.4 依赖版本策略

`rmcp` 是 MCP SDK 的唯一协议实现；D4-1 验证后固定确切版本、feature、MSRV 和许可证。`reqwest`、`tokio`、`tokio-tungstenite`、`sha2`、`base64`、`getrandom` 的版本必须以 workspace 的锁文件和目标 toolchain 实际解析结果为准，Cargo.toml 不写 `*` 或浮动范围。reqwest 不使用自动持久化 cookie；cookie 策略由 `session.rs` 实现，以便执行 §6 的安全约束。任何版本未实际解析前标为“待 D4-1/D5-2 验证”，不得在文档或验收中写成已验证。

## 3. 公共错误、权限和结果契约

### 3.1 错误映射

领域错误统一映射为概要设计 §5 的 `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`payload_too_large`、`too_many_attempts`、`storage_unavailable`、`internal`、`offline`。客户端取消、请求超时和响应体不符合 DTO 时，分别使用共享应用层定义的 `cancelled`、`request_timeout`、`invalid_response`；不得把这些原因折叠成 `offline`，也不得用 `internal` 或 `details.cancelled` 模糊代替。MCP transport 层不得把 SQL、路径、cookie、token 或附件内容放入错误详情。`conflict.details` 至少含 `resource`、`expected`、`actual`；笔记冲突含当前服务器/本地可恢复摘要，但不自动替换调用方输入。

JSON-RPC 层按 rmcp 规范返回协议错误；工具本身的领域失败返回 `isError=true` 的结构化结果：

```json
{
  "error": {
    "code": "conflict",
    "message": "The note changed since expected_rev.",
    "details": {"resource": "note", "id": "…", "expected": 3, "actual": 4}
  }
}
```

成功结果严格以 `web/src/worker/mcp/server.ts` 的 tool helper 为准：顶层工具结果保留各工具实际的 `structuredContent` 形状（不能笼统宣称全部 snake_case）；Rust 只做同形状 DTO 映射并拒绝未定义字段。写工具的 `operation_id` 只在实际 schema 存在时出现。读取结果必须有明确上限和 continuation cursor，不能一次返回整库或无界附件。

### 3.2 权限和危险操作

API key scope 冻结为：`notes:read`（全部读取工具）、`notes:write`（创建/编辑/组织/恢复/复制/文件夹/标签/属性/附件写入）、`notes:trash`（仅 `trash_note`）。服务器要求 key 同时具有工具所需 scope；无 scope 直接 `forbidden`，不尝试降级。设置中另有 `write_enabled` 和 `trash_enabled` 两个本地开关，关闭时即使 key 有 scope 也拒绝。

- `readOnlyHint=true`：全部读取、预览和图谱工具；`destructiveHint=false`、`idempotentHint=true`。
- `destructiveHint=true`：`trash_note`、`delete_tag`、`remove_folder_and_promote_contents`、`delete_attachment`；它们必须有明确 `operation_id`，并在调用前检查对应 guard。
- `create_note`、`duplicate_note` 等含 `operation_id` 的创建工具可幂等重试；`upload_attachment` 的 operation_id 只保护 MCP 本地事务，不能宣称 Web `/api/files` POST 具备幂等。D5 远端 files POST 没有 operation_id，丢响应后必须 reconcile，不能盲目重传。
- MCP 请求总体上限按每个 schema 的有效载荷计算：普通 tools/call JSON 限制为 4 MiB；`upload_attachment.data` 允许最多 36,000,000 个 base64 字符（对应不超过 25 MiB 原始附件，另加 JSON/字段开销的明确上限），因此上传工具使用单独的 `request_bytes <= 48 MiB` 限制，不能被普通 4 MiB guard 错误拒绝。普通读取、搜索、批量项仍严格服从 server.ts 的各自 zod 上限。

桌面不提供语义搜索：`search`/`search_notes` 的 `mode=auto` 固定实际执行 lexical；显式 `semantic` 或 `hybrid` 返回结构化 `forbidden`（`details.reason='semantic_search_unavailable'`），不能伪装成成功的关键词结果。`Backend.capabilities.semanticSearch` 保持 `false`。

## 4. MCP 工具详细契约

下表“成功结果”描述用途而非另造JSON schema；准确字段、大小写、嵌套结构以server.ts调用的retrieval/library/writes helper为准，schema夹具从实际注册工具获取而非正则提取源码。不得因为表中概述含“版本/摘要”而新增version_id、rev、next_cursor等helper未返回字段。tools/call同时保留SDK content与structuredContent合同。

### 4.1 检索、笔记和图谱

| 工具 | 输入要点 | 权限/危险 | 成功结果 |
| --- | --- | --- | --- |
| `search` | `query` 1–512 字符，`mode=auto\|lexical\|semantic\|hybrid` | `notes:read`，只读 | `results[{id,title,url}]`、实际 `mode` |
| `fetch` | `id` | `notes:read`，只读 | `id,title,text,url,metadata`，正文有最大长度和 `cursor` |
| `search_notes` | `query`、`limit≤20`、tags/folder/starred/archived、mode | `notes:read`，只读 | `results`、过滤条件回显、`next_cursor` |
| `list_notes` | `view=all\|recent\|starred\|archived\|trash`、`limit≤50`、cursor | `notes:read`，只读 | 摘要数组、`next_cursor`，不含无界正文 |
| `read_note` | `note_id`，section/cursor 或行范围，`max_chars≤40000` | `notes:read`，只读 | `note_id,title,rev,text,outline,section,next_cursor` |
| `get_note_context` | `note_id`、`limit≤30` | `notes:read`，只读 | outline、bounded outgoing/backlinks，最多一跳 |
| `list_folders` | 空对象 | `notes:read`，只读 | 文件夹 id、层级路径、笔记计数 |
| `list_tags` | `limit≤200` | `notes:read`，只读 | 私有标签名、颜色、使用计数 |
| `list_note_versions` | `note_id`、`limit≤50` | `notes:read`，只读 | 历史id/title/size/created_at；不伪造历史rev字段，准确字段以helper结果为准 |
| `read_note_version` | `note_id,version_id` | `notes:read`，只读 | 指定版本正文及元数据，受大小上限 |
| `explore_note_graph` | `note_id`、`depth≤3`、`max_nodes≤100` | `notes:read`，只读 | bounded nodes/edges，节点和边均去重 |

### 4.2 笔记写入和历史恢复

| 工具 | 输入要点 | 权限/危险 | 成功结果 |
| --- | --- | --- | --- |
| `create_note` | `operation_id`、可选 `note_id/title/folder_id`、`content` | `notes:write`，创建可幂等 | `operation_id,note{id,title,rev,folder_id,updated_at}` |
| `edit_note` | `operation_id,note_id,expected_rev`、operation（replace/replace_section/append/prepend/replace_all）、text、可选 old_text/section/title | `notes:write`，版本保护 | `note`、新 rev、版本 id、变更摘要 |
| `organize_note` | `operation_id,note_id,expected_rev`、folder/starred/archived/pinned | `notes:write`，版本保护 | 更新后的 note 摘要和 rev |
| `trash_note` | `operation_id,note_id,expected_rev` | `notes:trash` + `trash_enabled`，危险、可恢复 | 墓碑/删除时间、rev；不永久删除 |
| `restore_note` | `operation_id,note_id,expected_rev` | `notes:write`，版本保护 | 恢复后的 note 和 rev |
| `duplicate_note` | `operation_id,note_id` | `notes:write`，可幂等 | 新 note id、标题、rev、folder_id |
| `restore_note_version` | `operation_id,note_id,version_id,expected_rev` | `notes:write`，版本保护 | 恢复后的 note、新版本 id 和 rev |

### 4.3 文件夹、标签及附件

| 工具 | 输入要点 | 权限/危险 | 成功结果 |
| --- | --- | --- | --- |
| `create_folder` | 必需operation_id/name；可选folder_id/parent_id/icon/color | `notes:write`，可幂等 | 对齐createMcpFolder结果 |
| `update_folder` | 必需operation_id/folder_id/expected_updated_at；可选name/parent_id/icon/color | `notes:write`，在本地事务内校验时间戳 | 对齐updateMcpFolder结果；不等同REST接口 |
| `create_tag` | `operation_id`、可选 tag_id、name、color | `notes:write`，可幂等 | tag 对象 |
| `update_tag` | `operation_id,tag_id`、name/color | `notes:write`；影响正文时一事务 | tag、受影响笔记数量、rev 摘要 |
| `preview_tag_change` | `tag_id`、可选 next_name | `notes:read`，只读预览 | 合并目标、受影响笔记 id/count、风险 |
| `delete_tag` | `operation_id,tag_id` | `notes:write`，危险、可幂等 | 删除状态、受影响笔记数量和版本摘要 |
| `preview_folder_removal` | `folder_id` | `notes:read`，只读预览 | 将提升的子文件夹/笔记、冲突名、风险 |
| `remove_folder_and_promote_contents` | `operation_id,folder_id,expected_updated_at` | `notes:write`，危险 | folder 删除、提升清单、冲突状态 |
| `bulk_organize_notes` | `operation_id`、1–20 项，每项 note_id/expected_rev/变更 | `notes:write`；部分冲突不静默覆盖 | 每项 success/conflict、汇总计数；整体 operation 可重放 |
| `list_attachments` | 可选 note_id、`limit≤50`、cursor | `notes:read`，只读 | 元数据数组、`next_cursor`，不含 bytes |
| `read_attachment` | attachment_id、cursor、`max_bytes≤1 MiB` | `notes:read`，只读 | base64 chunk、总长度、next cursor、sha256 |
| `upload_attachment` | operation_id、filename、mime、data（base64）；attachment_id/note_id可选 | `notes:write`，按解码实际字节限制 | 对齐uploadMcpAttachment结果；不把参数名写成base64 |
| `delete_attachment` | `operation_id,attachment_id` | `notes:write`，危险、引用保护 | 删除/排队清理状态；被引用时 `conflict` |

### 4.4 属性

| 工具 | 输入要点 | 权限/危险 | 成功结果 |
| --- | --- | --- | --- |
| `get_note_properties` | `note_id` | `notes:read`，只读 | typed properties、note_id、当前 rev |
| `update_note_properties` | `operation_id,note_id,expected_rev`、mode merge/replace、properties | `notes:write`，版本保护 | properties、note、新 rev、版本 id |
| `query_note_properties` | conditions 1–8项，每项key/operator/value?；limit≤50 | `notes:read`，只读 | 对齐queryMcpNoteProperties有界结果，不额外发明分页参数 |

## 5. MCP 实现和幂等事务

### 5.1 SDK 适配层

`mcp::transport` 只创建 rmcp server、限制本地监听、安装 request size/timeout middleware、把 `McpConfig` 注入 server context；不读 SQLite。`tools::*` 只做 schema 解码、scope/preference 检查、DTO 转换，然后调用 `Library` 或 `McpQueryService`。所有入口带 `#[tracing::instrument(skip_all, fields(tool = %name, operation_id = tracing::field::Empty), err)]`，日志不得包含正文、附件、token 或完整请求。

初始化返回服务器名、确切版本、协议能力和工具说明；未初始化前除初始化和 ping 外拒绝请求。服务器只接受本机连接，并校验 `Host` 为 loopback；Origin 为空时仅允许非浏览器本地客户端，非空时只允许设置中显式登记的 trusted origin，不能把任意 localhost 网页当可信来源。rmcp 的协议生命周期和通知由 SDK 管理，业务代码不实现第二套 JSON-RPC 分派。

### 5.2 token 与权限

`mcp_tokens` 保存 `id,name,token_hash,scopes,created_at,last_used_at,revoked_at`；创建时使用 OS CSPRNG 生成 `ink_` token，只返回一次。比较使用恒时哈希比较；撤销立即生效。请求在进入工具前检查 token 状态、scope、频率和 body 限制，失败不泄漏 token 是否存在。`mcp_preferences` 保存 `write_enabled,trash_enabled`，读取一次后传给本次调用；不能通过 MCP 自己修改权限设置。

迁移由D4-2创建以下表，统一迁移注册表分配版本；不是D1 v2的一部分：

```sql
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE mcp_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1), write_enabled INTEGER NOT NULL DEFAULT 0,
  trash_enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE mcp_operations (
  operation_id TEXT PRIMARY KEY, tool TEXT NOT NULL,
  request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed','expired')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mcp_operations_created ON mcp_operations(created_at);
```

权限在每次调用（包括幂等重放）重新核验，撤销token不能通过缓存结果读取数据。7日内重放保存结果；超期清空response_json并保留operation_id/tool/hash墓碑、status=expired，旧ID返回conflict要求新ID，不删除后悄悄重做写入。权限错误不透露是否存在操作。桌面key默认notes:read，写与trash需用户开启偏好，工具注解不是授权。

key创建时scope由当前用户明确启用的write/trash偏好推导，默认只有notes:read；启用写权限不会静默扩大已有key的scope，用户需重建key或通过独立明确授权操作更新。默认监听127.0.0.1:7714以避免Web preview 7713占用；端口可配置，占用报错，绝不改成0.0.0.0。MCP只接受Authorization Bearer，query参数token拒绝，CORS无通配符。

### 5.3 统一 MCP 写入口

`Library::execute_mcp_write(request: McpWriteRequest) -> Result<McpToolResult, Error>`是唯一MCP写入口。McpWriteRequest为core定义的操作enum，使用同事务内部write函数；不将WriteTx闭包公开给mcp crate，不递归获取Library锁。入参先按工具schema规范化后stable JSON计算SHA256，请求哈希包含tool与参数。顺序为：

1. 开启一个 SQLite transaction，并按 `operation_id` 读取 `mcp_operations`。
2. 已有记录时比较 `tool` 和 `request_hash`：完全相同则直接返回保存的 result JSON，不再执行领域写；不同则返回 `conflict`，不修改任何数据。
3. 对新操作执行版本、资源存在性、权限和附件引用检查；调用同一 `Library` 写路径，`WriteOrigin::Mcp`，所有 notes/versions/links/FTS/change records 写入同一事务。
4. 在同一个 transaction 写 `mcp_operations` 的 request_hash、response_json、status、created_at；序列化结果失败则整个 transaction 回滚。
5. 提交后才由 service 发 library-changed 事件；事件丢失可由本地 cursor 重新读取，不影响幂等结果。

响应结果限额按合法工具输出上限约束；不会把大附件字节存入操作结果。SQLite失败整个事务回滚；附件文件先stage，成功后的引用和幂等记录同事务，FS孤儿按20恢复。批量操作在同一外层事务内逐项savepoint记录成功/冲突结果，整批响应一并存入幂等记录；不得在重放时重新计算影响范围。

### 5.4 与共享 Backend 生命周期的衔接

桌面 `Backend.dispose()` 必须先等待本地 SQLite 写入、MCP 已提交调用和当前文件 stage 的本地收尾，再取消监听、停止 MCP listener 与同步调度；它不等待远端 HTTP/WS 完成。正在进行的远端请求收到 `cancelled` 或 `request_timeout` 时，若尚未提交本地状态则保留 outbox/临时状态，若本地事务已提交则保持结果并由下次同步继续，不能伪造成功或删除队列。`notes.flush()` 的结果按共享契约返回 `FlushResult{pending, failed}`，退出提示只依据这两个计数；MCP 写入事件仍只进入统一 `changes`，不得恢复 `watchWrites` 第二总线。

## 6. D5 同步数据模型和会话安全

### 6.1 迁移归属

D5 的迁移追加在本文定义，由统一迁移表串接；不得把未使用的 `sync_map` 提前塞入 20 的核心迁移。迁移只追加不修改已发布版本；启动时遇到更高 schema 版本返回 `internal` 并保留数据。

### 6.2 完整 schema

以下是可直接迁移的 SQLite DDL；`binding_id + binding_epoch` 是所有同步表的隔离前缀，不能只按本地 note id 查询。游标是非负安全整数，使用 SQLite `INTEGER`，不是 TEXT；snapshot/after/nextKey 是独立字段。

```sql
CREATE TABLE sync_state (
  binding_id TEXT PRIMARY KEY NOT NULL,
  binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
  site_origin TEXT NOT NULL,
  account_hint TEXT NOT NULL,
  remote_user_id TEXT NOT NULL,
  cookie_ciphertext BLOB,
  cookie_domain TEXT NOT NULL,
  cookie_path TEXT NOT NULL,
  cookie_expires_at INTEGER,
  cookie_secure INTEGER NOT NULL DEFAULT 1, cookie_host_only INTEGER NOT NULL DEFAULT 1,
  cookie_name TEXT NOT NULL, cookie_same_site TEXT NOT NULL DEFAULT 'Lax',
  snapshot_run_id TEXT,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  snapshot_cursor INTEGER CHECK (snapshot_cursor IS NULL OR snapshot_cursor >= 0),
  after_key TEXT,
  status TEXT NOT NULL,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sync_map (
  binding_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('note','folder','tag')),
  local_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  local_rev INTEGER NOT NULL CHECK (local_rev >= 0),
  remote_rev INTEGER CHECK (remote_rev IS NULL OR remote_rev >= 0),
  sent_local_rev INTEGER CHECK (sent_local_rev IS NULL OR sent_local_rev >= 0),
  last_write_id TEXT,
  base_payload_json TEXT,
  base_hash TEXT,
  last_remote_cursor INTEGER CHECK (last_remote_cursor IS NULL OR last_remote_cursor >= 0),
  state TEXT NOT NULL,
  PRIMARY KEY (binding_id, binding_epoch, entity, local_id),
  UNIQUE (binding_id, binding_epoch, entity, remote_id),
  FOREIGN KEY (binding_id) REFERENCES sync_state(binding_id)
);

CREATE TABLE sync_outbox (
  binding_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('note','folder','tag','attachment')),
  write_id TEXT NOT NULL,
  local_id TEXT,
  local_rev INTEGER NOT NULL CHECK (local_rev >= 0),
  base_remote_rev INTEGER,
  sent_local_rev INTEGER CHECK (sent_local_rev IS NULL OR sent_local_rev >= 0),
  observed_cursor INTEGER NOT NULL CHECK (observed_cursor >= 0),
  ack_prereq TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload BLOB NOT NULL,
  attachment_refs TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  last_error_code TEXT,
  recovery_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, binding_epoch, write_id),
  FOREIGN KEY (binding_id) REFERENCES sync_state(binding_id)
);

CREATE TABLE sync_attachment_map (
  binding_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL,
  local_attachment_id TEXT NOT NULL,
  remote_attachment_id TEXT,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  upload_intent_json TEXT,
  state TEXT NOT NULL,
  PRIMARY KEY (binding_id, binding_epoch, local_attachment_id),
  FOREIGN KEY (binding_id) REFERENCES sync_state(binding_id)
);

CREATE TABLE sync_snapshot (
  binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  run_id TEXT NOT NULL, entity TEXT NOT NULL,
  remote_id TEXT NOT NULL, remote_rev INTEGER, payload_json TEXT NOT NULL,
  PRIMARY KEY(binding_id,binding_epoch,run_id,entity,remote_id)
);
CREATE TABLE sync_conflict (
  id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
  entity TEXT NOT NULL, local_id TEXT, remote_id TEXT,
  local_payload TEXT NOT NULL, remote_payload TEXT NOT NULL,
  reason TEXT NOT NULL, resolved_at INTEGER, created_at INTEGER NOT NULL
);

CREATE INDEX sync_outbox_ready ON sync_outbox(binding_id, binding_epoch, state, next_attempt_at, created_at, write_id);
CREATE INDEX sync_map_remote ON sync_map(binding_id, binding_epoch, remote_id);
```

`sync_state`没有全局rev；mapping保存每实体最后确认的local_rev/remote_rev。folder/tag没有rev，local_rev为0且remote_rev为null，冲突比较base_payload_json/base_hash。note响应没有cursor，ACK只确认发送write_id/sent_local_rev并更新实体remote_rev，不推进拉取cursor。纯同步应用不得再enqueue相同变更；恢复副本是显式本地新写。

- `binding_epoch` 是绑定生命周期版本；重绑定必增，不得复用旧队列。
- `local_rev` 是本地 Library 的修订，`remote_rev` 是服务端笔记修订；二者不可比较大小。`sync_map` 记录两端最后确认版本、`sent_local_rev` 和对应 `write_id`。
- cursor是最后完整应用的远端变化序号；snapshot_cursor/after_key/snapshot_run_id是独立的暂存状态。没有可由普通写响应得到的ack_cursor，故不建立这个字段。删除接口返回的游标只用于墓碑/校验，不能跳过中间其他实体变更。
- `ack_prereq` 是发送该项前必须满足的前置条件 JSON，至少含 `binding_id,binding_epoch,local_id,expected_remote_rev,required_attachment_ids`；附件上传完成、绑定仍是当前 epoch、远端版本仍可验证是 ack 前提。前提不满足时不发送并转为 blocked，不删除队列。
- 本地 cursor、远端 cursor、远端 rev 和本地 rev 永远不能互相覆盖；ACK 只能确认对应旧 `write_id/sent_local_rev`，不能确认其间产生的新 local_rev。

同步表约束补充：应用启动读取prefs中唯一currentBindingId，再按完整(binding_id,epoch)查询。相同实体remoteId唯一，已隔离旧绑定只读；所有state/kind使用Rust枚举校验。snapshot_run_id随机生成，快照首屏清本run旧暂存；非首屏不能重置facets。完整快照/增量只给摘要，尚缺正文的note必须GET成功或确认404后才能完成本页/本轮checkpoint。映射记录比当前本地rev旧意味着仍有本地待同步，不代表远端数据可以覆盖。

### 6.3 cookie 会话和重定向

`session.rs` 只接受配置 origin 返回的 `Set-Cookie`。解析并保存 cookie 的 name/value、host/domain、path、Secure、HttpOnly、SameSite、Max-Age/Expires；默认 host-only，默认 path 按 RFC 计算。发送时同时执行域匹配、path 匹配、过期检查和 Secure 检查；过期 cookie 删除，不发送已过期值。日志只记 host、path、是否过期和状态，不记值。

HTTP client 禁止自动跟随跨 origin 重定向。每个 3xx 必须检查目标 scheme/host/port：只允许配置 origin 的同源目标；不得把“任意 localhost”当可信 Origin。MCP 的非空 Origin 只接受设置中显式登记的 trusted origin，空 Origin 仅限非浏览器本地客户端；未登记的 localhost 网页、跨域、协议降级或端口改变一律拒绝。绝不把 Cookie、Authorization 或正文转发到重定向目标。Set-Cookie 也不能通过重定向响应植入不匹配的域/path。DPAPI protect/unprotect 失败、cookie 解密失败或 secret store 不可用都返回明确错误并暂停同步；禁止明文、环境变量或日志 fallback。

### 6.4 首次绑定和重绑定

首次绑定绝不静默覆盖或删除任一侧数据。用户必须先选择策略并看到预览：

1. **保留本地并导出到远端**：只创建不存在的远端资源；同 ID/同内容才建立映射，远端已有不同内容保留并标冲突。
2. **导入远端为本地副本**：远端快照全部以新本地 ID 写入，绝不删除已有本地笔记；同标题不覆盖。
3. **合并并保留双方**：相同内容才合并映射；任何内容、rev、附件或 metadata 差异都生成冲突副本和待处理状态。

预览包含本地/远端计数、匹配数、冲突数、附件数量和潜在网络写入。取消或预览失败不改变数据。没有用户确认不能执行绑定。

重绑定先停止旧 engine，持久化旧 binding 的状态，再创建新的 `binding_id/binding_epoch`。旧 epoch 的 outbox 标记 `quarantined`，新 engine 查询必须带当前 binding_id 和 epoch；旧队列不得在新账户或新站点发送。用户可在导出旧队列后显式丢弃，丢弃不是重绑定的隐含副作用。

## 7. RemoteApi、pull/push 和附件

### 7.1 RemoteApi

`note_sync::RemoteApi` 使用 `async_trait`，唯一公开 trait 覆盖现有服务端接口；所有网络调用均为异步，取消由 `CallOptions` 传入，错误携带机器 code：

```rust
#[async_trait::async_trait]
pub trait RemoteApi: Send + Sync {
    async fn login(&self, origin: &str, username: &str, password: &str, signal: &CallOptions) -> Result<PasswordLoginResult, RemoteError>;
    async fn complete_totp(&self, origin: &str, challenge: &str, code: &str, signal: &CallOptions) -> Result<TotpLoginResult, RemoteError>;
    async fn validate_session(&self, binding: &Binding, signal: &CallOptions) -> Result<SessionInfo, RemoteError>;
    async fn sync_page(&self, request: SyncPageRequest, signal: &CallOptions) -> Result<SyncPage, RemoteError>;
    async fn get_note(&self, binding: &Binding, note_id: &str, signal: &CallOptions) -> Result<RemoteNote, RemoteError>;
    async fn create_note(&self, binding: &Binding, request: CreateRemoteNote, signal: &CallOptions) -> Result<RemoteNote, RemoteError>;
    async fn patch_note(&self, binding: &Binding, note_id: &str, request: PatchRemoteNote, signal: &CallOptions) -> Result<RemoteNote, RemoteError>;
    async fn trash_note(&self, binding: &Binding, note_id: &str, signal: &CallOptions) -> Result<RemoteNote, RemoteError>;
    async fn restore_note(&self, binding: &Binding, note_id: &str, request: RestoreRemoteNote, signal: &CallOptions) -> Result<RemoteNote, RemoteError>;
    async fn purge_note(&self, binding: &Binding, note_id: &str, signal: &CallOptions) -> Result<PurgeResult, RemoteError>;
    async fn list_folders(&self, binding: &Binding, signal: &CallOptions) -> Result<Vec<RemoteFolder>, RemoteError>;
    async fn create_folder(&self, binding: &Binding, input: FolderCreate, signal: &CallOptions) -> Result<RemoteFolder, RemoteError>;
    async fn patch_folder(&self, binding: &Binding, id: &str, input: FolderPatch, signal: &CallOptions) -> Result<RemoteFolder, RemoteError>;
    async fn remove_folder(&self, binding: &Binding, id: &str, strategy: FolderDeleteStrategy, signal: &CallOptions) -> Result<(), RemoteError>;
    async fn list_tags(&self, binding: &Binding, signal: &CallOptions) -> Result<Vec<RemoteTag>, RemoteError>;
    async fn create_tag(&self, binding: &Binding, input: TagCreate, signal: &CallOptions) -> Result<RemoteTag, RemoteError>;
    async fn patch_tag(&self, binding: &Binding, id: &str, input: TagPatch, signal: &CallOptions) -> Result<TagPatchResult, RemoteError>;
    async fn remove_tag(&self, binding: &Binding, id: &str, signal: &CallOptions) -> Result<TagRemoveResult, RemoteError>;
    async fn list_attachments(&self, binding: &Binding, cursor: Option<AttachmentCursor>, signal: &CallOptions) -> Result<AttachmentPage, RemoteError>;
    async fn upload_file(&self, binding: &Binding, file: UploadFile, signal: &CallOptions) -> Result<RemoteAttachment, RemoteError>;
    async fn remove_file(&self, binding: &Binding, id: &str, signal: &CallOptions) -> Result<(), RemoteError>;
    async fn download_file(&self, binding: &Binding, attachment_id: &str, range: ByteRange, signal: &CallOptions) -> Result<AttachmentBytes, RemoteError>;
    async fn subscribe_changes(&self, binding: &Binding, signal: &CallOptions) -> Result<ChangeSubscription, RemoteError>;
}
```

HTTP DTO按现有shared类型解析；请求名用`rev`，不是凭空加`expected_rev`。SyncPageRequest含binding/since/after/snapshot，Response为SyncResponse。files列表没有SHA256字段：先按filename/size/noteId筛选，再下载候选计算SHA256比对；无法唯一确认则unknown_outcome暂停。附件下载不假设Range被服务端支持，200完整体流式写入同样合法，206时验证范围。TLS正常验证；认证头与cookie不跟跨源跳转。

### 7.2 pull

pull 串行读取当前 epoch。增量请求使用非负整数 `since`，按服务端返回的 `cursor/hasMore/nextKey` 继续；不把 note 响应的 rev 当 cursor。遇到 `full=true`，必须先在 staging 中收集完整快照：首屏保存 `snapshot`/`snapshot_cursor`、`nextKey`，后续请求固定 `since=0&after=<nextKey>&snapshot=<snapshot_cursor>`；后续页重复首屏 cursor，空 facets 不能清空集合。整轮 staging 完成后，再从 snapshot cursor 补拉增量，最后一次性提交 `facetsFull`、notes、deletions 和最终 cursor。页面提交失败保留旧 checkpoint，不能每页推进最终 cursor。

应用 staged 数据时，若本地有未发送更高 `local_rev`，远端正文不能覆盖本地脏内容；保留远端版本和本地待发送内容。拉取事务只更新本页暂存状态或最终合并结果，不更新无关 local_rev。
### 7.3 push

push 严格按当前 epoch 的 `sync_outbox.created_at,write_id` 顺序取项。发送前检查 `ack_prereq`：附件已上传、绑定仍有效、远端版本仍可验证。写入请求携带该项的 `base_remote_rev`；成功后在 core 事务中记录 remote id/rev、`sent_local_rev`、write_id 并标记对应 outbox acked；不从 note response 推进 cursor，也不确认其间新产生的 local_rev。

409 必须沿既定 outbox 策略执行：读取 `details.server`，若服务端内容已与待发内容一致则按已保存处理；否则将该项基线更新为 server.rev、设置 `preserveVersion:true`，保留服务端版本并重发本地优先内容。不得自行引入三方 merge。更新基线前持久化，失败则停留 pending。原始 write_id 保留。

404 必须先持久化 `recovery_id`，然后以该 ID `POST /api/notes` 创建恢复副本；同 ID 重试由服务端创建语义保证幂等。不得删除本地原笔记或盲目重新生成 recovery ID。

### 7.4 metadata 无 CAS 的风险处理

文件夹、标签等现有远端 API 没有 CAS 参数，D5 不伪造 `expected_updated_at` 已提供强一致性。处理顺序为：发送 metadata 写入前强制 pull 最新集合；在本地 engine 写锁下比较入队快照的 `updated_at`/内容 hash；若已知发生变化，标记 `metadata_conflict`，保留远端快照和本地期望，不发送覆盖写，要求用户选择。即使比较后再发生竞态，服务端仍可能被覆盖；该风险必须在状态、日志和 UI 中明确显示，写入记录 remote response 和时间，不能宣称无冲突。

metadata 冲突解决是显式的新 operation：选择远端、选择本地重试或合并后重试。解决前不重复自动重试；pull 不删除本地集合成员，删除墓碑也只在有明确远端 cursor 且无本地未发送变更时应用。即使比较后再发生竞态，服务端仍可能被覆盖；验收不得宣称“保证不覆盖”，只能验证已知变更被拦截并将竞态风险显示给用户。

### 7.5 附件传输副本与 ID 重写

本地笔记、Markdown/YAML 属性和本地附件表中的 ID 永远不改写。push 创建独立的传输 DTO/临时文件副本，在副本中把 `local_attachment_id` 替换为已确认的 `remote_attachment_id`；远端返回后仅写 `sync_attachment_map`。pull 下载远端附件到临时路径，校验长度和 sha256 后以新的本地 attachment id 原子落盘，并在本地引用事务中建立映射。任何失败清理未引用临时文件，不能删除仍被本地笔记引用的正式文件。

附件先于引用它的笔记push。POST /api/files不支持operation_id，发送前持久化上传意图（本地ID/hash/size/文件名/相关笔记及发送前已知远端ID集合）；丢响应后列出候选并下载计算hash，唯一匹配才确认映射，多个/零候选不能确定时暂停unknown_outcome，提供用户核对和显式重试，不保证服务器绝无孤儿重复。下载只能在本地完成hash校验后发布；服务端无可信hash字段时不要宣称远端hash已认证。MCP本地upload的operation_id与此远端REST问题是两个合同。

### 7.6 realtime

实时通道只触发“有变更可 pull”，不直接应用正文。WS 连接使用当前绑定 cookie，心跳超时按指数退避；连接失败降级为带抖动的轮询，恢复后先 pull 再恢复正常间隔。WS/轮询均不得推进 cursor 而不执行 pull。状态经 `StatusSink` 和 Tauri `autonote://sync-status` 报告，具体进度使用 IPC Channel；成功 pull/push 后发 library ChangeFeed，提交并释放数据库锁后才发事件。

## 8. 公开 API 与 command

### 8.1 Rust traits

`RemoteApi`唯一声明在§7.1，不再定义另一套同步签名。`CallOptions`包含deadline与取消令牌；任何网络await前释放SQLite锁。`SecretStore`只在shell实现，不把Windows FFI引入core：

```rust
pub trait SecretStore: Send + Sync {
    fn protect(&self, value: &[u8]) -> Result<Vec<u8>, SecretError>;
    fn unprotect(&self, value: &[u8]) -> Result<Vec<u8>, SecretError>;
}
pub trait StatusSink: Send + Sync {
    fn changed(&self, status: &SyncStatus);
}
```

core的公开同步操作为`stage_sync_page(binding,run,page)`、`commit_sync_snapshot(binding,run,expected_cursor)`、`claim_sync_write(binding)`、`ack_sync_write(binding,write_id,sent_local_rev,response)`、`record_sync_conflict(...)`。每个方法在core内独立短事务；不把Connection/WriteTx交给sync crate。MCP使用结构化`McpWriteRequest`进入core单事务，不能给外部闭包公开WriteTx再嵌套Library事务。

### 8.2 Tauri commands

所有command async返回Result，错误按10；网络服务用Tokio，core阻塞操作放blocking池。参数均经验证，凭据参数不日志、不持久明文。

| command | 参数 | 返回 |
| --- | --- | --- |
| mcp_status / mcp_start / mcp_stop | 无 | McpLocalStatus（running/endpoint/port/error） |
| mcp_set_port | port:u16 | McpLocalStatus；运行中先安全重启，端口占用保留旧配置 |
| mcp_list_keys / mcp_create_key / mcp_revoke_key | 无 / name / id | McpApiKey[] / {key,token} / {ok:true} |
| mcp_get_preferences / mcp_save_preferences | 无 / {writeEnabled?,trashEnabled?} | McpPreferences |
| sync_login | origin,username,password | {loginId,result:PasswordLoginResult}；短期loginId关联内存cookie |
| sync_complete_totp | loginId,challengeToken,code | {loginId,result:TotpLoginResult} |
| sync_status | 无 | SyncStatus |
| sync_bind_preview | loginId,strategy | {previewId,counts,conflicts,expiresAt}；不改变本地笔记/远端 |
| sync_bind_confirm | previewId | SyncStatus；复核本地/远端变化，失效预览重新确认 |
| sync_unbind | bindingId | SyncStatus；先停engine并隔离未确认队列，不静默删除 |
| sync_start / sync_stop / sync_now | 无 | SyncStatus |
| sync_resolve_conflict | conflictId,choice:'local'|'remote'|'keep-both' | SyncStatus |

SyncStatus含bindingId/epoch/phase/localCursor/remoteCursor/pending/blocked/conflicts/online/errorCode，不含cookie或正文。服务状态事件`autonote://sync-status`/`autonote://mcp-status`仅给宿主设置；领域变化仍走library-changed，互不代替。MCP返回的引用URL使用`autonote://note/<id>`稳定标识；不是公开HTTP分享，22的MCP客户端说明明确这一点。

## 9. 实施计划

### D4-1 MCP SDK 与协议装配

- **依赖**：D1-2、D2-1。
- **改动范围**：`desktop/src-tauri/mcp/{Cargo.toml,transport.rs,lib.rs,schema.rs}`、workspace `Cargo.toml/Cargo.lock`、`desktop/fixtures/mcp-tools.json`、MCP 协议夹具。
- **不做**：不实现业务写入、不创建 token、不修改 Worker、不手写 JSON-RPC/MCP 协议。
- **步骤**：1. 在目标 rust-toolchain 下评估维护状态并选定 `rmcp`，实际解析 server、streamable-http 所需 feature、确切版本、MSRV 和许可证；把确切版本锁入 Cargo。2. 用 SDK 装配 initialize/initialized/ping/tools/list/tools/call 及 HTTP transport，限制 loopback、Host/Origin、body、超时和连接数。3. 定义 34 工具的输入 schema、输出 schema、只读/危险/idempotent 注解，生成并校验夹具。4. 用真实 MCP 客户端进行握手、列工具和一次成功/一次错误调用，记录 SDK 版本和 wire 结果。
- **判据**：目标toolchain可解析锁定rmcp并真实握手；未知方法/未初始化调用按SDK协议失败。D4-1只注册已有实现的只读探针，不用34个空handler冒充完工；D4-5最终验收34工具齐全。鉴权前限制总体请求上限并约束连接数，解析后按工具限额；合法25MiB上传不被普通4MiB门误拒，非法超限请求被拒。
- **陷阱**：不能因为当前 lock 中没有 SDK 就回退手写协议；必须核实 rmcp 的 feature/API 和 MSRV。不得把 Web 的 39 个云工具误复制为桌面的 34 个。

### D4-2 鉴权、权限和设置守卫

- **依赖**：D4-1、D2-5、D2-6。
- **改动范围**：`core/src/store/mcp.rs`、`mcp/src/auth.rs`、`mcp/src/transport.rs`、`src/commands/mcp.rs`、`src/services/mcp.rs`、MCP 设置 DTO/迁移。
- **不做**：不实现外部 OAuth、不保存明文 token、不暴露备份/分享/账户管理。
- **步骤**：1. 追加 `mcp_tokens` 和 `mcp_preferences` 迁移、索引和 core CRUD。2. 生成 `ink_` token，使用恒时哈希比较，创建响应只显示一次；实现撤销立即生效和 last-used 脱敏记录。3. 在工具调用前执行 scope、write_enabled/trash_enabled、速率、body 和资源范围检查。4. 暴露 mcp 状态/key/preferences commands，并在设置页显示风险和监听状态。
- **判据**：1. 新 key 只在创建响应出现一次，重启/读取/日志中均无明文；撤销后的真实请求被拒绝。2. 缺 `notes:read/write/trash` 或设置关闭时分别得到 `forbidden`；`trash_note` 没有 trash scope 永远不能执行。3. 过期/错误 token、非 loopback 请求和超限请求不会泄露 key 存在性。4. Windows 真实桌面启动服务、创建/撤销 key、重启后状态正确保留。
- **陷阱**：不要只在 UI 隐藏危险开关；服务端必须再次检查。错误日志不得记录 Authorization、完整 operation_id 请求或正文。

### D4-3 只读工具

- **依赖**：D4-1、D4-2、D1-3、D1-6、D1-7。
- **改动范围**：`core/src/query/mcp.rs`、`mcp/src/tools/read.rs`、`mcp/src/tools/attachments.rs`、`mcp/src/tools/properties.rs`、`schema.rs`、只读契约测试/夹具。
- **不做**：不写笔记/标签/文件夹，不修改附件，不调用网络，不暴露无界正文或任意路径。
- **步骤**：实现34工具集合中的17个读取/预览工具：检索8、历史读取2、图谱1、附件读取2、属性读取2、影响预览2；按实际server.ts及helper结果结构逐项实现schema、边界、分页，禁止猜测字段。
- **判据**：真实SDK调用17个工具，覆盖未知ID、过期cursor、超限、空结果、多页正文、代码块/属性、附件分块重组；权限不足失败；返回JSON结构与Web对应helper合同一致但本地URL按§8解释。
- **陷阱**：不要把 `fetch` 当作无界导出；不要在查询层拼接 SQL；不要将本地文件路径或正文写入日志。

### D4-4 写工具、危险操作与单事务幂等

- **依赖**：D4-2、D4-3、D1-4、D1-5、D1-7。
- **改动范围**：`core/src/store/mcp.rs`、`core/src/query/mcp.rs`（写入 DTO）、`mcp/src/tools/write.rs`、`mcp/src/tools/organize.rs`、`mcp/src/tools/attachments.rs`、`core/src/library` 写入口和事件适配。
- **不做**：不静默 rebase GUI/MCP，不永久 purge，不在 MCP 层开启第二个事务，不让附件 FS rename 冒充 SQLite 事务。
- **步骤**：1. 实现 `execute_mcp_write` 单 transaction：查操作、hash 校验、调用 Library 写路径、记录完整结果后提交。2. 接入创建/编辑/组织/删除/恢复/复制/版本恢复、文件夹/标签及附件写工具，逐个实现 expected_rev/expected_updated_at 和 operation_id。3. 对 trash/tag/folder/attachment 删除加 scope、偏好和 destructive annotation；preview 工具在 mutation 前返回影响清单。4. 实现附件 stage/rename/引用保护和崩溃恢复扫描；提交后发 library-changed。
- **判据**：1. 相同 operation_id 和相同请求重试只返回首次结果、不重复创建/改 rev；同 ID 不同 hash 返回 conflict 且数据库无变化。2. 在注入提交前崩溃/磁盘错误时，领域写和 mcp_operations 均回滚；不会出现“写已成功但无幂等记录”或反向情况。3. 旧 expected_rev、缺少 trash scope、关闭写/回收站开关、删除被引用附件都得到明确错误，正文不被覆盖。4. 真实调用后 ChangeFeed 只在提交并释放锁后产生，GUI 能观察到 MCP 写入且不会收到正文广播；危险 preview 与实际 mutation 的受影响清单一致。
- **陷阱**：禁止先查 `mcp_operations` 再调用 Library；禁止捕获错误后返回成功空对象；批量操作必须逐项保留成功/冲突结果并保证重放一致。

### D4-5 MCP 设置、生命周期与真实客户端验收

- **依赖**：D4-1、D4-2、D4-4、D2-5。
- **改动范围**：`desktop/src/lib/ipc/ports/mcp.ts`、`desktop/src/lib/settings/McpSection.svelte`、`src/commands/mcp.rs`、`src/services/mcp.rs`、能力声明、日志和启动/停止组合根。
- **不做**：不增加 Web MCP 能力，不允许任意公网监听，不在设置页显示 token 历史值。
- **步骤**：1. 将 MCP start/stop/status/key/preferences commands 接入组合根，保证 `Backend.capabilities.mcp='local'` 与服务真实状态一致。2. 设置页提供 loopback 端口、启停、写入/回收站开关、key 创建/撤销和复制一次性配置片段。3. 处理重复启动、端口占用、退出清理、服务异常和 token 撤销事件。4. 使用维护的 MCP 客户端完成真实协议和 34 工具的 smoke 场景，保存 D4-1 的实际 SDK 版本证据。
- **判据**：1. 启停、端口占用、应用退出、重复启动和撤销 key 均在真实桌面进程中可观察并返回机器错误码。2. 设置开关会立即影响下一次工具调用；配置片段不含明文 token 以外的持久化凭据或公网地址。3. 真实客户端可初始化、列出 34 工具、搜索、读取、创建、版本冲突和撤回一篇测试笔记；危险工具在关闭权限时失败。4. `cargo metadata --locked`、桌面定向 MCP smoke 和 SDK 版本记录通过；未验证的版本不得写入“已支持”。
- **陷阱**：服务停止时必须关闭 listener 和 token state；不要使用全局静态服务绕开组合根；不要用模拟客户端回显代替真实 MCP 客户端。

### D5-1 存储会话、迁移与 DPAPI

- **依赖**：D1-2、D2-6。
- **改动范围**：`core/src/store/sync.rs`、迁移注册、`shell/src/credentials/`、`sync/src/session.rs`、`sync/src/bind.rs`、同步 DTO。
- **不做**：不实现 HTTP pull/push，不修改服务端，不保存明文 cookie，不把 sync_map 放回 20 的已发布迁移。
- **步骤**：1. 追加并注册 §6.2 的 `sync_state/sync_map/sync_outbox/sync_attachment_map` schema、索引、epoch 外键语义和迁移回滚保护。2. 实现 Windows DPAPI protect/unprotect，所有 unsafe 块写 SAFETY 注释；非 Windows 返回明确不可用错误或使用经批准的系统 secret store，绝不明文降级。3. 解析并验证 cookie 的 domain/path/expiry/Secure，持久化密文及元数据。4. 实现 binding 状态、当前 epoch、队列计数和安全擦除临时 secret。
- **判据**：临时库的6张同步表、索引和epoch隔离可实际迁移；DPAPI重启解密有效且失败无明文fallback；cookie域/path/过期/Secure策略正确；重绑定后旧队列隔离，远端userId不同即暂停，不按用户名猜同一用户。
- **陷阱**：不得用unwrap处理凭据；不能把operation ACK当pull cursor；folder/tag不伪造远端rev。

### D5-2 RemoteApi、HTTP 会话与服务端兼容性

- **依赖**：D5-1、D1-2。
- **改动范围**：`sync/src/{remote.rs,session.rs,lib.rs}`、Cargo manifest/lock、HTTP/WS DTO 夹具和本地测试服务器适配器。
- **不做**：不改 `web/src/worker`，不引入远端 schema 迁移，不承诺 metadata CAS。
- **步骤**：1. 实际验证 reqwest/rustls、tokio-tungstenite 及目标 Rust toolchain 的版本/feature，固定 lock 并记录结果。2. 实现 `RemoteApi` 的现有同步、笔记、metadata、附件和实时端点，严格按 shared DTO 解码。3. 禁止自动跨源重定向，按 §6.3 管理 cookie 和超时/429/401/409/404。4. 用现有 Web API 的本地实例/真实测试实例验证请求和响应，未改变任何服务端代码。
- **判据**：1. `cargo metadata --locked` 和实际 HTTPS 请求成功；TLS、认证过期、429 retryAfter、offline、非法 DTO 分别映射预期错误。2. 同源 3xx 可按规则处理，跨域/降级/端口变化重定向携带 cookie 时被拒绝。3. 真实 API 的 sync page、note rev conflict、attachment sha256 和 WS 通知与 shared DTO 一致。4. `git diff`/代码评审确认服务端无改动；metadata 请求明确标记无 CAS，不伪造强一致性。
- **陷阱**：reqwest feature 名和 lock 版本必须实测，不能根据旧版本猜；不要开启自动 cookie jar 后又手动保存一份导致发送两次。

### D5-3 首次绑定、预览、确认和 epoch 隔离

- **依赖**：D5-1、D5-2、D1-4、D1-5、D1-7。
- **改动范围**：`sync/src/bind.rs`、`core/src/store/sync.rs`、`src/commands/sync.rs`、`src/services/sync.rs`、`desktop/src/lib/ipc/ports/sync.ts`、`SyncSection.svelte`。
- **不做**：不静默覆盖/删除本地或远端数据，不自动丢弃旧队列，不在预览阶段写领域数据。
- **步骤**：1. 实现三种显式策略（保留本地导出、导入远端副本、合并保留双方）及计数/冲突/附件预览。2. 预览使用临时 snapshot，不推进正式 cursor、不写 outbox；用户确认后创建 binding/epoch。3. 重绑定停止旧 engine、隔离旧队列、创建新 epoch，并提供导出/显式丢弃旧队列。4. 将绑定状态、确认提示、冲突和风险接入设置页与 IPC。
- **判据**：1. 首次绑定无确认、取消、预览失败均不改变本地/远端数据和 cursor。2. 三种策略的真实夹具场景分别证明：不删除本地、不静默覆盖远端、差异生成副本/冲突。3. 重绑定后旧 epoch 的 outbox 在新站点/账户永不发送；旧队列可查看、导出、显式丢弃。4. 绑定状态重启后保留 site/account hint、epoch 和脱敏状态，不显示 cookie。
- **陷阱**：同标题不等于同 ID；不能以标题匹配覆盖数据。新 binding 不能复用旧 binding_id，也不能只清空队列掩盖数据风险。

### D5-4 pull、游标和本地合并

- **依赖**：D5-2、D5-3、D1-3、D1-4、D1-5、D1-6。
- **改动范围**：`sync/src/pull.rs`、`core/src/store/sync.rs`、`core/src/library` 远端应用入口、同步契约测试。
- **不做**：不推送本地写入，不把远端 cursor 当本地 rev，不覆盖有更高 local_rev 的脏正文。
- **步骤**：增量页短事务提交后推进cursor；full先stage全轮、固定snapshot/after、保留首页facets，再补增量后原子安装；摘要变更另GET正文并验证其rev，404生成删除处理；本地dirty保存双方，不用远端覆盖。
- **判据**：full第二页中断重启不清空folders/tags、不遗漏页外笔记；未完成全轮cursor不提前确认；正文GET期间再次编辑或404正确处理；本地dirty与远端rev分离；提交后library事件一次发布。
- **陷阱**：不要先推进 cursor 再写库；不要按 `remote_rev > local_rev` 判断两域可比较；分页 token 异常必须停同步而非从头静默覆盖。

### D5-5 push、outbox、冲突和 metadata 风险

- **依赖**：D5-2、D5-3、D5-4、D1-4、D1-5、D1-7。
- **改动范围**：`sync/src/push.rs`、`sync/src/engine.rs`、`core/src/store/sync.rs`、冲突 DTO/UI 和 ChangeFeed 适配。
- **不做**：不无限重试 4xx，不静默 rebase GUI/MCP，不宣称无 CAS metadata 写入强一致。
- **步骤**：冻结发送writeId/sent_local_rev；200只确认对应旧写；409相同内容直接确认，否则持久新base_rev并preserveVersion重发；404先持久recovery_id再幂等create；metadata先比较快照，已知冲突暂停；401/429/离线分类保留队列。
- **判据**：响应丢失后note创建不重复，发送期间新输入不被旧ACK确认；409远端旧版本可读，404恢复ID稳定；metadata已知冲突拒绝自动覆盖，并明确比较后仍有竞态风险；文件上传unknown_outcome按D5-6处理，不能声称自动exactly-once。
- **陷阱**：不能因为 HTTP 200 就确认本地较新的内容；ack_prereq 缺失或 epoch 不匹配必须 blocked。冲突副本要能被用户找到，不能只写日志。

### D5-6 附件同步和传输副本

- **依赖**：D5-4、D5-5、D1-7。
- **改动范围**：`sync/src/attachments.rs`、`core/src/store/sync.rs`、`core/src/files`、附件传输 DTO、崩溃恢复任务。
- **不做**：不改写本地 Markdown/属性/附件 ID，不把临时文件直接注册为正式文件，不允许任意路径。
- **步骤**：1. 为本地附件建立 map，上传前复制到受限临时目录并校验 sha256/size。2. 只在传输 DTO 中把 local id 替换为已确认 remote id，填写 `ack_prereq`；本地领域对象保持原 ID。3. 下载远端 bytes 到临时文件，校验后原子 rename 并在 core 事务写引用/map。4. 启动时扫描临时文件、无引用文件和半完成 map，按状态恢复或安全清理。
- **判据**：本地源文ID不改、远端传输副本引用映射正确；上传成功丢响应时实际列候选并计算hash，唯一候选确认，歧义暂停而非盲传；stage/rename/DB故障重启保留引用文件；未下载附件不能显示为已离线可用；下载篡改/超限/路径穿越被拒。
- **陷阱**：禁止用字符串全局替换本地正文来重写附件 ID；FS 和 SQLite 不是同一事务，必须有引用保护和恢复扫描。

### D5-7 实时状态、串行 engine 和真实同步验收

- **依赖**：D5-4、D5-5、D5-6、D2-3、D2-6。
- **改动范围**：`sync/src/{realtime.rs,engine.rs,lib.rs}`、`src/services/sync.rs`、`src/commands/sync.rs`、`desktop/src/lib/ipc/ports/sync.ts`、`SyncSection.svelte`、托盘订阅。
- **不做**：不把 WS 消息直接当正文，不开第二条 watchWrites 总线，不在客户端 Promise 丢弃后假装取消。
- **步骤**：1. 实现一个串行 engine，pull/push 互斥，所有状态转换带 binding epoch。2. 实现 WS 心跳、断线退避、轮询降级和恢复时先 pull；消息只触发 pull。3. 通过 StatusSink/IPC Channel 输出 phase、队列数、cursor、冲突、terminal；提交后发统一 library ChangeFeed。4. 在本地测试 Web 实例和真实桌面进程执行首次绑定、pull、push、409、metadata 无 CAS、附件、断网恢复、重绑定和 WS→轮询场景。
- **判据**：同步触发合并为单engine；WS失败轮询且重连先pull；领域事件用library-changed，服务状态用sync-status，不广播正文；真实桌面+本地Worker完成绑定、断网恢复、409、404、附件丢响应、重绑定旧队列隔离、退出重启，记录实际结果。
- **陷阱**：不要跨 await 持有 std Mutex；不要把取消调用当作取消已提交写入；WS 断线不能清空 outbox 或重置 cursor，必须从持久状态恢复。

## 10. 交付检查清单

1. D4-1 的 `rmcp` 实际版本、feature、MSRV、许可证和 `cargo metadata --locked` 证据已记录；没有手写协议路径。
2. 34 个工具逐项具备输入 schema、结果字段、scope、幂等语义、危险注解和真实调用证据；云端备份/分享工具未被误纳入。
3. MCP 所有写入均经 `execute_mcp_write` 单事务，幂等结果和领域写入不可分离提交；过期 rev 不静默覆盖。
4. D5使用bindingId/epoch、每实体localRev/remoteRev、发送writeId/sentLocalRev、整数pull cursor与附件映射；无冗余ack_cursor，不混淆序列。
5. 首次绑定需要策略、预览和确认，不静默覆盖/删除；重绑定按 binding/epoch 隔离旧队列。
6. cookie 具备 domain/path/过期/Secure/重定向检查，DPAPI 失败无明文 fallback；日志不含凭据。
7. 同步不改服务端；metadata 无 CAS 的风险、冲突和解决路径可观察；附件 ID 只在传输副本中重写。
8. 本文件定义12项未来实施任务，当前均待执行；任务依赖与索引见03，不能把设计完成误当代码验收通过。
