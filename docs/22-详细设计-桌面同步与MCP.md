# 22 详细设计：桌面同步与 MCP

> 状态：阶段设计基线；本文件只描述 D4（本地 MCP 服务）和 D5（同步到 Web 实例），不代表代码已经完成。D5（§6–§8、§9 的 D5 任务）于 2026-10-21 按"脏标记 + 基准版本 CAS + 冲突副本"方案重写，后续实现以此为准。
> 契约来源：`02-概要设计.md`（§3 端口、§4 类型、§5 错误码、§6 ChangeFeed、§7 写入语义、§8 IPC）；工程写法来源：`04-工程规范.md`。
> 引用约定：`20 §x` 指 `20-详细设计-桌面内核.md`，`21 §x` 指 `21-详细设计-桌面宿主.md`，`10 §x` 指 `10-详细设计-共享应用层.md`。所有路径以 AutoPad 仓库根为准。

## 1. 结论与边界

### 1.1 MCP 采用维护的 Rust SDK

本地 MCP 服务采用维护中的 Rust SDK **`rmcp`**，不再手写最小 MCP 协议，也不以“少引入几个 crate”为选型依据。`rmcp` 负责 JSON-RPC 消息、初始化协商、工具列表/调用、通知、协议错误和选定的 HTTP/streamable-http 传输；`note-mcp` 只负责鉴权、工具契约、权限、调用 `note-core` 以及把领域错误映射为 MCP 错误。

`rmcp` 的确切版本不能凭记忆填写。D4-1 必须在目标锁定的 Rust toolchain、目标平台和当前 Cargo registry 上实际执行 `cargo add`/`cargo metadata`，确认 SDK 的 server API、streamable HTTP feature、依赖许可和 MSRV；随后把解析出的**确切版本**写入对应 `Cargo.toml` 与 `Cargo.lock`。D4-1 的验收必须包含该命令输出和真实客户端握手、`tools/list`、`tools/call` 结果。没有这些证据不得声称 SDK 版本已验证，也不得退回手写协议。

协议服务只提供本地知识库，不是调用外部 MCP 的客户端；不代理外部工具、不把外部 MCP 凭据存入本地库。监听地址默认 `127.0.0.1`，不得绑定局域网地址。原始 token 只在创建时显示一次，数据库只保存哈希。

### 1.2 34 个工具的冻结清单

桌面 MCP 暴露恰好以下 34 个工具，名称、参数名和结果语义与 Web MCP 的知识库工具保持一致；实现中以共享 DTO 和工具契约夹具防止漂移。云端备份、公开分享及账户管理不是本地知识库操作，不纳入桌面 34 工具，不因 Web 端存在对应能力而暴露。

| 组            | 工具                                                                                                                                                                                    |   数量 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
| 检索          | `search`、`fetch`、`search_notes`、`list_notes`、`read_note`、`get_note_context`、`list_folders`、`list_tags`                                                                           |      8 |
| 笔记写入/历史 | `create_note`、`edit_note`、`organize_note`、`trash_note`、`restore_note`、`duplicate_note`、`list_note_versions`、`read_note_version`、`restore_note_version`                          |      9 |
| 文件夹/标签   | `create_folder`、`update_folder`、`create_tag`、`update_tag`、`preview_tag_change`、`delete_tag`、`preview_folder_removal`、`remove_folder_and_promote_contents`、`bulk_organize_notes` |      9 |
| 附件          | `list_attachments`、`read_attachment`、`upload_attachment`、`delete_attachment`                                                                                                         |      4 |
| 属性          | `get_note_properties`、`update_note_properties`、`query_note_properties`                                                                                                                |      3 |
| 图谱          | `explore_note_graph`                                                                                                                                                                    |      1 |
| **合计**      |                                                                                                                                                                                         | **34** |

每个工具的参数以 `web/src/worker/mcp/server.ts` 的 zod schema 为权威；桌面通过导出的夹具生成同样的 JSON Schema，不自行添加或删除任何字段。写工具中只有实际 schema 声明的 `operation_id` 才参与 MCP 幂等。所有笔记正文和属性修改使用 `expected_rev`；文件夹/标签等字段没有远端 CAS 时，桌面 MCP 不把本地时间戳伪装成强一致 CAS。Ui/MCP 的过期版本只返回 `conflict`，绝不静默 rebase；只有 D5 的远端回放允许按 §7 的规则保留双方版本。

桌面 `note-core` 是单库单用户，`mcp_operations` 没有 `user_id`。幂等键是 `operation_id`；tool 和 request_hash 必须在同一事务中比较，工具名或请求体不同即 `conflict`。

### 1.3 同步沿用现有服务端接口

D5 只调用现有 HTTP/WS 接口，不改 Worker 或服务端 schema。服务端已提供本方案需要的全部能力：每用户单调的变更流、笔记 `rev` 的 compare-and-swap（不匹配返回 409 和服务器版本）、客户端指定 id 的幂等创建、WebSocket 变更通知。文件夹和标签的 REST 写入没有 CAS，按 §7.4 以"后写者胜"处理并接受这一取舍。

### 1.4 统一事务与事件边界

MCP 写操作必须由 `note-core` 在**一个 SQLite transaction** 中完成：查幂等记录、校验请求哈希、读取/检查版本、修改领域数据及索引、写 `mcp_operations` 并保存完整结果，最后一次提交。禁止 MCP 层先开一个事务查 `mcp_operations`、再让 Library 开第二个事务写入；禁止“业务已提交但幂等结果未提交”或相反的两阶段实现。提交后释放数据库锁，再发 `autonote://library-changed`，不在事务内发事件。

文件系统附件不能假定和 SQLite 同一事务。附件采用临时文件、fsync、原子 rename、数据库引用保护和启动恢复扫描；未被已提交记录引用的临时文件可清理，已被记录引用的正式文件不得误删。

## 2. 范围、依赖与模块布局

### 2.1 本文负责

| 范围                                                                         | 职责                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `desktop/src-tauri/mcp/`                                                     | rmcp server 装配、认证、34 工具适配、schema、结果和调用限制                                            |
| `desktop/src-tauri/core/src/store/mcp.rs`、`query/mcp.rs`                    | MCP 操作幂等记录、MCP 专用只读查询和领域结果                                                           |
| `desktop/src-tauri/sync/`                                                    | 会话、绑定、pull/push、附件传输、实时通知和串行调度                                                    |
| `desktop/src-tauri/core/src/sync.rs`、`core/src/sync/`                       | D5 迁移、绑定状态、脏标记、远端版本和附件映射的读写                                                    |
| `desktop/src-tauri/shell/src/credentials.rs`                                 | Windows 保持原 DPAPI；macOS/Linux 复用 Aether 系统密钥环 + AEAD 字节凭据接口；失败不得明文降级，详见40 |
| `desktop/src-tauri/src/commands/{mcp,sync}.rs`、`src/services/{mcp,sync}.rs` | Tauri command 转发、事件和服务组合根                                                                   |
| `desktop/src/lib/ipc/ports/{mcp,sync}.ts`、设置分区                          | 前端端口和 MCP/同步设置显示                                                                            |
| `desktop/fixtures/mcp-tools.json`                                            | 34 工具的参数/结果/注解契约夹具                                                                        |

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
├── shell/src/credentials.rs          # 平台 SecretStore 适配；Windows DPAPI FFI 在此
├── mcp/src/
│   ├── lib.rs                         # McpServer、McpConfig、TokenStore、StatusSink
│   ├── transport.rs                   # rmcp server/streamable-http 装配
│   ├── auth.rs                        # token 哈希、scope、来源校验和限流
│   ├── schema.rs                      # 工具 schema/结果契约
│   └── tools/{read,write,organize,attachments,properties}.rs
├── sync/src/
│   ├── lib.rs                         # 导出 SyncService、RemoteClient、SyncStatus
│   ├── remote.rs                      # RemoteClient：HTTP/WS，不改服务端
│   ├── session.rs                     # cookie 解析、域/path/过期/重定向策略
│   ├── service.rs                     # 登录、绑定、串行循环、状态与事件
│   ├── pull.rs、push.rs               # 增量/快照拉取；按脏标记推送和冲突副本
│   └── attachments.rs                 # 附件上传/下载与传输副本 ID 重写
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
    "details": { "resource": "note", "id": "…", "expected": 3, "actual": 4 }
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

| 工具                 | 输入要点                                                         | 权限/危险          | 成功结果                                                                  |
| -------------------- | ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `search`             | `query` 1–512 字符，`mode=auto\|lexical\|semantic\|hybrid`       | `notes:read`，只读 | `results[{id,title,url}]`、实际 `mode`                                    |
| `fetch`              | `id`                                                             | `notes:read`，只读 | `id,title,text,url,metadata`，正文有最大长度和 `cursor`                   |
| `search_notes`       | `query`、`limit≤20`、tags/folder/starred/archived、mode          | `notes:read`，只读 | `results`、过滤条件回显、`next_cursor`                                    |
| `list_notes`         | `view=all\|recent\|starred\|archived\|trash`、`limit≤50`、cursor | `notes:read`，只读 | 摘要数组、`next_cursor`，不含无界正文                                     |
| `read_note`          | `note_id`，section/cursor 或行范围，`max_chars≤40000`            | `notes:read`，只读 | `note_id,title,rev,text,outline,section,next_cursor`                      |
| `get_note_context`   | `note_id`、`limit≤30`                                            | `notes:read`，只读 | outline、bounded outgoing/backlinks，最多一跳                             |
| `list_folders`       | 空对象                                                           | `notes:read`，只读 | 文件夹 id、层级路径、笔记计数                                             |
| `list_tags`          | `limit≤200`                                                      | `notes:read`，只读 | 私有标签名、颜色、使用计数                                                |
| `list_note_versions` | `note_id`、`limit≤50`                                            | `notes:read`，只读 | 历史id/title/size/created_at；不伪造历史rev字段，准确字段以helper结果为准 |
| `read_note_version`  | `note_id,version_id`                                             | `notes:read`，只读 | 指定版本正文及元数据，受大小上限                                          |
| `explore_note_graph` | `note_id`、`depth≤3`、`max_nodes≤100`                            | `notes:read`，只读 | bounded nodes/edges，节点和边均去重                                       |

### 4.2 笔记写入和历史恢复

| 工具                   | 输入要点                                                                                                                                | 权限/危险                                     | 成功结果                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `create_note`          | `operation_id`、可选 `note_id/title/folder_id`、`content`                                                                               | `notes:write`，创建可幂等                     | `operation_id,note{id,title,rev,folder_id,updated_at}` |
| `edit_note`            | `operation_id,note_id,expected_rev`、operation（replace/replace_section/append/prepend/replace_all）、text、可选 old_text/section/title | `notes:write`，版本保护                       | `note`、新 rev、版本 id、变更摘要                      |
| `organize_note`        | `operation_id,note_id,expected_rev`、folder/starred/archived/pinned                                                                     | `notes:write`，版本保护                       | 更新后的 note 摘要和 rev                               |
| `trash_note`           | `operation_id,note_id,expected_rev`                                                                                                     | `notes:trash` + `trash_enabled`，危险、可恢复 | 墓碑/删除时间、rev；不永久删除                         |
| `restore_note`         | `operation_id,note_id,expected_rev`                                                                                                     | `notes:write`，版本保护                       | 恢复后的 note 和 rev                                   |
| `duplicate_note`       | `operation_id,note_id`                                                                                                                  | `notes:write`，可幂等                         | 新 note id、标题、rev、folder_id                       |
| `restore_note_version` | `operation_id,note_id,version_id,expected_rev`                                                                                          | `notes:write`，版本保护                       | 恢复后的 note、新版本 id 和 rev                        |

### 4.3 文件夹、标签及附件

| 工具                                 | 输入要点                                                                      | 权限/危险                             | 成功结果                                               |
| ------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `create_folder`                      | 必需operation_id/name；可选folder_id/parent_id/icon/color                     | `notes:write`，可幂等                 | 对齐createMcpFolder结果                                |
| `update_folder`                      | 必需operation_id/folder_id/expected_updated_at；可选name/parent_id/icon/color | `notes:write`，在本地事务内校验时间戳 | 对齐updateMcpFolder结果；不等同REST接口                |
| `create_tag`                         | `operation_id`、可选 tag_id、name、color                                      | `notes:write`，可幂等                 | tag 对象                                               |
| `update_tag`                         | `operation_id,tag_id`、name/color                                             | `notes:write`；影响正文时一事务       | tag、受影响笔记数量、rev 摘要                          |
| `preview_tag_change`                 | `tag_id`、可选 next_name                                                      | `notes:read`，只读预览                | 合并目标、受影响笔记 id/count、风险                    |
| `delete_tag`                         | `operation_id,tag_id`                                                         | `notes:write`，危险、可幂等           | 删除状态、受影响笔记数量和版本摘要                     |
| `preview_folder_removal`             | `folder_id`                                                                   | `notes:read`，只读预览                | 将提升的子文件夹/笔记、冲突名、风险                    |
| `remove_folder_and_promote_contents` | `operation_id,folder_id,expected_updated_at`                                  | `notes:write`，危险                   | folder 删除、提升清单、冲突状态                        |
| `bulk_organize_notes`                | `operation_id`、1–20 项，每项 note_id/expected_rev/变更                       | `notes:write`；部分冲突不静默覆盖     | 每项 success/conflict、汇总计数；整体 operation 可重放 |
| `list_attachments`                   | 可选 note_id、`limit≤50`、cursor                                              | `notes:read`，只读                    | 元数据数组、`next_cursor`，不含 bytes                  |
| `read_attachment`                    | attachment_id、cursor、`max_bytes≤1 MiB`                                      | `notes:read`，只读                    | base64 chunk、总长度、next cursor、sha256              |
| `upload_attachment`                  | operation_id、filename、mime、data（base64）；attachment_id/note_id可选       | `notes:write`，按解码实际字节限制     | 对齐uploadMcpAttachment结果；不把参数名写成base64      |
| `delete_attachment`                  | `operation_id,attachment_id`                                                  | `notes:write`，危险、引用保护         | 删除/排队清理状态；被引用时 `conflict`                 |

### 4.4 属性

| 工具                     | 输入要点                                                            | 权限/危险               | 成功结果                                               |
| ------------------------ | ------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `get_note_properties`    | `note_id`                                                           | `notes:read`，只读      | typed properties、note_id、当前 rev                    |
| `update_note_properties` | `operation_id,note_id,expected_rev`、mode merge/replace、properties | `notes:write`，版本保护 | properties、note、新 rev、版本 id                      |
| `query_note_properties`  | conditions 1–8项，每项key/operator/value?；limit≤50                 | `notes:read`，只读      | 对齐queryMcpNoteProperties有界结果，不额外发明分页参数 |

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

桌面 `Backend.dispose()` 必须先等待本地 SQLite 写入、MCP 已提交调用和当前文件 stage 的本地收尾，再取消监听、停止 MCP listener 与同步调度；它不等待远端 HTTP/WS 完成。正在进行的远端请求收到 `cancelled` 或 `request_timeout` 时，本地脏标记保持不变，由下次同步继续，不能伪造成功或清除脏标记。`notes.flush()` 的结果按共享契约返回 `FlushResult{pending, failed}`，退出提示只依据这两个计数；MCP 写入事件仍只进入统一 `changes`，不得恢复 `watchWrites` 第二总线。

## 6. D5 同步数据模型和会话安全

### 6.0 方案选择与依据

本节是 2026-10-21 的重写版本，取代原来的 outbox/epoch/快照暂存方案。原方案代码只能拉取：生产代码从不写 `sync_outbox`，推送不可达；全量快照提交时不写入笔记；文件夹和标签只记映射、不写本地表；"是否有未上传修改"又依赖 outbox，导致拉取会静默覆盖本地编辑。

新方案是"每行脏标记 + 基准版本 CAS + 冲突副本"，与成熟实现一致：

| 做法                                           | 依据                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地写入在同一事务里自动登记修改               | Joplin 用 `sync_items.sync_time < updated_time` 找待同步项（`packages/lib/models/BaseItem.ts` `itemsThatNeedSync`）；PowerSync 本地写入自动进入上传队列 `ps_crud` |
| 同步写入和用户写入分开，同步写入不登记修改     | Joplin 保存同步数据时用 `changeSource: SOURCE_SYNC`，不刷新时间戳                                                                                                 |
| 推送带"我认为的服务器版本"，不匹配由服务器拒绝 | RxDB replication 的 `assumedMasterState`；本服务端 `PATCH /api/notes/:id` 的 `rev` 就是同一协议                                                                   |
| 笔记冲突保留两份，元数据冲突以远端为准         | Joplin `handleConflictAction.ts`：`NoteConflict` 生成冲突笔记，`ItemConflict` 采用远端                                                                            |
| 实时通道只提示"该拉了"，重连后补拉             | Replicache poke；RxDB `RESYNC`                                                                                                                                    |
| 拉取在一致的检查点一次性应用                   | PowerSync 检查点完整后才写入数据表                                                                                                                                |

推送记录的最新状态，不记录逐次操作：笔记编辑频繁，推最新状态天然合并多次修改；顺序依赖用固定推送顺序（§7.3）解决。

### 6.1 迁移归属

D5 迁移追加在本文定义，由统一迁移表串接，只追加、不修改已发布版本；启动时遇到更高 schema 版本返回 `internal` 并保留数据。新方案的迁移在同一版本里新建 §6.2 的表，把旧 `sync_state` 当前行的站点、账户、cookie 密文和游标搬进 `sync_binding`，再删除旧同步表。旧表其余内容没有生产数据（outbox 只有测试写入，快照暂存和冲突记录未被使用），直接删除。

### 6.2 schema

```sql
-- 当前绑定：最多一行。
CREATE TABLE sync_binding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_origin TEXT NOT NULL,
  account_hint TEXT NOT NULL,
  remote_user_id TEXT NOT NULL,
  cookie_ciphertext BLOB NOT NULL,
  cookie_name TEXT NOT NULL,
  cookie_domain TEXT NOT NULL,
  cookie_path TEXT NOT NULL,
  cookie_expires_at INTEGER,
  cookie_secure INTEGER NOT NULL DEFAULT 1,
  cookie_host_only INTEGER NOT NULL DEFAULT 1,
  cookie_same_site TEXT NOT NULL DEFAULT 'Lax',
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  last_success_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL
);

-- 每个实体一行：远端已确认版本，以及是否有待推送的本地修改。
CREATE TABLE sync_item (
  entity TEXT NOT NULL CHECK (entity IN ('note','folder','tag')),
  id TEXT NOT NULL,
  remote_rev INTEGER,             -- 仅笔记使用；NULL 表示远端还没有这条记录
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0,1)),
  PRIMARY KEY (entity, id)
);
CREATE INDEX sync_item_dirty ON sync_item(entity) WHERE dirty = 1;

-- 附件：远端 id 由服务器分配，与本地 id 不同。
CREATE TABLE sync_attachment (
  local_id TEXT PRIMARY KEY,
  remote_id TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0)
);
```

规则：

- **id 两端相同。** 笔记、文件夹、标签的远端创建接口都接受客户端 id（`POST /api/notes`、`/api/folders`、`/api/tags` 的 `id`），所以不需要本地/远端 id 映射。只有附件的远端 id 由服务器分配，用 `sync_attachment` 记录。
- **脏标记在写入层登记。** `Library::write(origin, …)` 在提交前，对本事务触及的每个笔记、文件夹、标签执行 `INSERT INTO sync_item(entity,id,dirty) VALUES(?,?,1) ON CONFLICT(entity,id) DO UPDATE SET dirty=1`，与业务写入同一事务。`origin == WriteOrigin::Sync` 时不登记。未绑定时同样登记，所以绑定前的离线修改在第一次推送时上传。
- **触及集合来自 `WriteTx`。** 它已经收集 `changes.notes` 和 `changes.deletions`；文件夹和标签目前只有 `folders_changed`/`tags_changed` 两个布尔值，改成记录具体 id（`changes.folders`、`changes.tags`）。UI、MCP、导入、版本恢复、复制、清空回收站都经过 `Library::write`，只改这一处。
- **删除也是脏记录。** 笔记和文件夹是软删除（`deleted_at`），推送时按当前行状态决定调用哪个接口（§7.3）。标签和彻底删除的笔记是硬删除，本地行不存在而 `sync_item` 仍为 dirty，推送时据此发送删除请求。
- **`remote_rev` 只在三处更新**：拉取写入远端版本时、推送成功拿到响应时、409 接受服务器版本时。本地 `notes.rev` 与 `remote_rev` 是两个计数器，永不比较大小。
- **游标** 是最后完整应用的远端变更序号，只在拉取事务提交时推进。

旧方案的 `sync_state`、`sync_map`、`sync_outbox`、`sync_snapshot`、`sync_conflict`、`sync_attachment_map`，以及 binding epoch、隔离队列、`ack_prereq`、`observed_cursor`、`sent_local_rev`、`write_id`、`recovery_id` 全部删除。

### 6.3 cookie 会话和重定向

`session.rs` 只接受配置 origin 返回的 `Set-Cookie`。解析并保存 cookie 的 name/value、host/domain、path、Secure、HttpOnly、SameSite、Max-Age/Expires；默认 host-only，默认 path 按 RFC 计算。发送时同时执行域匹配、path 匹配、过期检查和 Secure 检查；过期 cookie 删除，不发送已过期值。日志只记 host、path、是否过期和状态，不记值。服务端续期返回新 `Set-Cookie` 时，在同一轮同步结束前加密写回 `sync_binding`。

HTTP client 禁止自动跟随跨 origin 重定向。每个 3xx 必须检查目标 scheme/host/port：只允许配置 origin 的同源目标；不得把"任意 localhost"当可信 Origin。绝不把 Cookie、Authorization 或正文转发到重定向目标，Set-Cookie 也不能通过重定向响应植入不匹配的域/path。DPAPI 或系统密钥环 protect/unprotect 失败、cookie 解密失败都返回明确错误并暂停同步；禁止明文、环境变量或日志 fallback。

### 6.4 绑定和解绑

绑定只有一种行为：**合并，差异保留两份**，不再提供三种策略。

1. 登录拿到 cookie 后预览：拉取远端全量快照（不写本地），与本地按 id 对比，统计"仅本地 / 仅远端 / 两边相同 / 两边不同"四类数量给用户确认。
2. 确认后在一个事务里：写 `sync_binding`；仅远端的记录以 `WriteOrigin::Sync` 写入本地并记 `remote_rev`；两边相同的记录只写 `sync_item(remote_rev, dirty=0)`；两边不同的笔记先按 §7.3 的冲突规则生成本地冲突副本，再写入远端版本；两边不同的文件夹和标签直接采用远端；仅本地的记录保持 `dirty=1`，由第一次推送上传；游标设为快照游标。
3. 同标题不等于同一条笔记，只按 id 匹配。

解绑先停止同步循环，再删除 `sync_binding` 行和 `sync_attachment`，把所有 `sync_item` 重置为 `dirty=1, remote_rev=NULL`。本地笔记、文件夹、标签不删除。重新绑定到同一或另一个站点时，按上面的合并流程处理，本地修改不会丢失。远端 `user_id` 与绑定时不同（同站点换了账户）时暂停同步，提示用户解绑后重新绑定，不按用户名猜测是否同一人。

## 7. 拉取、推送、冲突和附件

### 7.1 RemoteClient

`note_sync::RemoteClient`（`sync/src/remote.rs`）是对现有服务端接口的唯一封装，不再定义 trait。保留现有方法：`login`、`complete_totp`、`validate_session`、`sync_page`、`get_note`、`create_note`、`patch_note`、`trash_note`、`restore_note`、`purge_note`、`list_folders`、`list_tags`、`metadata_write`、`list_attachments`、`upload_file`、`remove_file`、`download_file`、`subscribe_changes`。所有调用都带 `CallOptions`（截止时间和取消令牌），任何网络 await 之前释放 SQLite 锁。

DTO 按现有 shared 类型解析；请求字段用服务端的 `rev`，不新造 `expected_rev`。TLS 正常校验；认证 cookie 不跟随跨源跳转。附件下载接受 200 完整响应，不假设服务端支持 Range。

### 7.2 拉取

每轮同步先拉后推。

1. 用 `GET /api/sync?since=<cursor>` 读增量页，按 `hasMore` 继续翻页；摘要中有变化的笔记用 `GET /api/notes/:id` 取正文。
2. 服务端返回 `full=true`（游标为 0、或游标早于服务端保留的变更日志）时，按 `after/snapshot` 读完整个快照，全部放在内存里；单用户笔记量可以一次装下。快照读完后再从快照游标补拉增量，与快照合并。
3. 在**一个事务**里应用（`WriteOrigin::Sync`，所以不会登记脏标记），然后推进游标：
   - **笔记**：本地 `sync_item.dirty=0` 时写入远端版本（正文、标题、文件夹、置顶、星标、归档、删除时间），更新 `remote_rev`；`dirty=1` 时不覆盖本地，只记录"远端有更新"，留给推送阶段按 409 处理。
   - **文件夹和标签**：本地不脏时写入远端版本；本地脏时本地保留，推送时覆盖远端（§7.4）。
   - **删除**：远端删除的笔记、文件夹、标签，本地不脏时删除（笔记和文件夹软删除，标签硬删除）；本地脏时保留本地，推送时重新创建。
   - **全量快照**：快照中没有、本地有、且 `remote_rev IS NOT NULL` 的记录说明已在远端被删除，按上一条处理；`remote_rev IS NULL` 的记录是本地新建、尚未推送，保持不动。
4. 正文中引用的附件在事务之前下载（§7.5），下载失败则本轮不推进游标。
5. 事务提交后发一次 library ChangeFeed，界面刷新。

不变量：**游标只在本轮所有页面成功写入的同一事务里推进**；中途失败下一轮从旧游标重来，服务端变更流按序号单调，重复应用是幂等的。

### 7.3 推送

每轮按固定顺序推送 `sync_item.dirty=1` 的记录，先父后子、先创建后删除：

1. 新建和修改的**文件夹**（父文件夹在前）、**标签**；
2. 新建和修改的**笔记**（正文中引用的本地附件先上传，§7.5）；
3. 删除的笔记、标签、文件夹（子在前）。

笔记按当前本地行决定请求：

| 本地状态             | `remote_rev` | 请求                                                                                                   |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| 存在、未删除         | NULL         | `POST /api/notes`，带本地 id、正文、标题、文件夹、星标；返回后若置顶/归档与默认值不同，再 `PATCH` 一次 |
| 存在、未删除         | 有值         | `PATCH /api/notes/:id`，`rev=remote_rev`，带正文、标题、文件夹、置顶、星标、归档                       |
| 已软删除             | 有值         | `DELETE /api/notes/:id`（移到回收站）；从回收站恢复则 `POST /:id/restore`                              |
| 行不存在（彻底删除） | 有值         | `DELETE /api/notes/:id/purge`；远端还没进回收站时先 `DELETE /:id`                                      |
| 已软删除或行不存在   | NULL         | 远端从未有过，直接清除 `sync_item`                                                                     |

结果处理：

- **成功**：用响应里的 `rev` 更新 `remote_rev`。只有在推送期间本地没有新写入时才清除 `dirty`：推送前读取本地 `notes.rev`，确认事务里 `UPDATE … SET dirty=0 WHERE` 本地 `rev` 未变；变了就保持 `dirty=1`，下一轮再推。
- **409（服务器版本已变）**：先比较 `details.server` 的正文和元数据，与本地一致则视为成功（上次请求已生效但响应丢失）。不一致则是真冲突：在一个事务里把本地版本另存为新笔记（新 id、标题加"（冲突 yyyy-MM-dd HH:mm）"、`dirty=1`），再把原 id 写成服务器版本并清除 `dirty`。冲突副本在下一轮作为新笔记上传，两边都能看到。
- **404（远端已删除）**：远端不再有这条笔记，而本地修改了它，以本地为准：清空 `remote_rev`，下一轮以同一 id 重新 `POST` 创建。
- **创建时 409（同 id 已存在但内容不同）**：服务端判定为不同记录，把本地记录换新 id 后重新创建，原 id 采用远端版本。
- **401**：暂停同步，状态提示重新登录；**429/5xx/离线**：保持 `dirty`，按退避重试；**其他 4xx**：该条记录标记错误码并跳过，不阻塞其余记录，不无限重试。

不需要 outbox、`write_id` 或 `recovery_id`：笔记创建用客户端 id，重试天然幂等；修改的重放由 409 + 内容比较判定是否已生效。

### 7.4 文件夹和标签

服务端的文件夹、标签写入没有 CAS。采用"后写者胜"，不做冲突检测：拉取阶段本地不脏则采用远端，本地脏则保留本地，推送阶段覆盖远端。单用户场景下，同一文件夹在两台设备上同时改名的概率很低，丢失的也只是一个名称或颜色，不是正文。

- 文件夹：`POST /api/folders`（带本地 id）、`PATCH /api/folders/:id`、`DELETE /api/folders/:id?strategy=move-up`。
- 标签：服务端的标签大多由正文中的 `#标签` 派生，笔记推送后自动存在。只同步手动创建的标签和颜色：`POST /api/tags`（带本地 id）、`PATCH /api/tags/:id`、`DELETE /api/tags/:id`。同名标签已存在时服务端返回 409，采用远端 id 并把本地关联改过去。

### 7.5 附件

本地笔记正文、属性和本地附件表里的附件 id **永远不改写**。

- **上传**：推送笔记前，找出正文 `/api/files/<本地id>` 引用中在 `sync_attachment` 里没有记录的附件，先 `POST /api/files` 上传，拿到远端 id 后写入 `sync_attachment(local_id, remote_id, sha256, size)`。发送笔记时只在请求体副本里把本地 id 替换成远端 id。
- **上传响应丢失**：重试前用 `list_attachments` 按文件名、大小、所属笔记找候选，下载候选算 sha256，唯一匹配就记录映射；找不到再重新上传。可能在远端留下一个孤立的重复文件，由服务端的 `POST /api/files/prune` 清理，不影响正确性。
- **下载**：拉取的正文里出现 `sync_attachment` 中没有的远端 id 时，下载到临时文件，校验大小后计算 sha256，以新的本地 id 原子落盘并写映射；写入本地正文时把远端 id 替换为本地 id。
- 每次同步不再全量扫描附件目录；`files_recover` 只在库打开时执行一次。

### 7.6 实时通知和调度

- **一个循环**：`SyncService` 只持有一个后台任务。`start()` 已在运行时直接返回当前状态，不再创建第二个循环；`stop()` 取消唯一的任务并等待它退出。
- **触发**：三种情况会立即开始一轮同步：本地写入提交后（`Library::write` 的非 `Sync` 写入通知 `wake`，500 ms 防抖合并连续输入）；WebSocket 收到 `changed`；定时轮询（默认 15 秒，WebSocket 正常时 5 分钟）。
- **WebSocket** 只表示"有变化可以拉"，不直接应用数据。断线后指数退避重连，重连成功先补拉一次。连续断线时退避到轮询，不形成每秒重试的循环。
- **开机自动启动**：应用启动时如果有 `sync_binding`，自动 `start()`。
- **错误**：每轮失败把错误码写入 `sync_binding.last_error_code` 并用 `tracing::warn` 记录（不含 cookie 和正文）；只有一轮完全成功才清除错误码并写 `last_success_at`。不再在每轮开始时清空错误。
- **退避**：失败后等待 2 s、4 s … 最长 60 s 再试，成功后恢复正常间隔。

## 8. 公开 API 与 command

### 8.1 Rust 接口

`SecretStore` 只在 shell 实现，不把平台 FFI 引入 core：

```rust
pub trait SecretStore: Send + Sync {
    fn protect(&self, value: &[u8]) -> Result<Vec<u8>, SecretError>;
    fn unprotect(&self, value: &[u8]) -> Result<Vec<u8>, SecretError>;
}
```

core 的同步操作（`core/src/sync.rs`），每个都是独立短事务，不把 `Connection`/`WriteTx` 交给 sync crate：

| 方法                                                                | 作用                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------- |
| `sync_binding()` / `sync_bind(binding, snapshot)` / `sync_unbind()` | 读取、建立（§6.4 合并）、解除绑定                       |
| `sync_apply(cursor, notes, folders, tags, deletions, full)`         | §7.2 的一次性应用，`WriteOrigin::Sync`，推进游标        |
| `sync_dirty(limit)`                                                 | 按 §7.3 顺序返回待推送记录及其当前本地行                |
| `sync_settle(entity, id, remote_rev, local_rev_seen)`               | 推送成功：更新 `remote_rev`，本地未再修改时清除 `dirty` |
| `sync_fork_conflict(id, server_note)`                               | 409 真冲突：本地另存冲突副本，原 id 写入服务器版本      |
| `sync_attachment_map(local_id, remote_id, sha256, size)`            | 记录附件映射                                            |
| `sync_record_result(error_code)`                                    | 写 `last_error_code`/`last_success_at`                  |

### 8.2 Tauri commands

所有 command 都是 async 并返回 Result，错误按 10 处理；网络调用用 Tokio，core 阻塞操作放 blocking 池。参数都要校验，凭据参数不记日志、不明文持久化。

| command                                         | 参数                               | 返回                                                                    |
| ----------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| mcp_status / mcp_start / mcp_stop               | 无                                 | McpLocalStatus（running/endpoint/port/error）                           |
| mcp_set_port                                    | port:u16                           | McpLocalStatus；运行中先安全重启，端口占用保留旧配置                    |
| mcp_list_keys / mcp_create_key / mcp_revoke_key | 无 / name / id                     | McpApiKey[] / {key,token} / {ok:true}                                   |
| mcp_get_preferences / mcp_save_preferences      | 无 / {writeEnabled?,trashEnabled?} | McpPreferences                                                          |
| sync_login                                      | origin,username,password           | {loginId,result:PasswordLoginResult}；短期 loginId 关联内存 cookie      |
| sync_complete_totp                              | loginId,challengeToken,code        | {loginId,result:TotpLoginResult}                                        |
| sync_status                                     | 无                                 | SyncStatus                                                              |
| sync_bind_preview                               | loginId                            | {previewId,localOnly,remoteOnly,same,different,expiresAt}；不写任何数据 |
| sync_bind_confirm                               | previewId                          | SyncStatus；远端在预览后变化则要求重新预览                              |
| sync_unbind                                     | 无                                 | SyncStatus；停止循环、删除绑定，本地数据保留并全部标为待推送            |
| sync_start / sync_stop / sync_now               | 无                                 | SyncStatus                                                              |

`SyncStatus` 字段：`phase`（`unbound`/`idle`/`syncing`/`paused`，只存内存，重启后从 `idle` 开始）、`siteOrigin`、`account`、`cursor`、`pending`（`dirty=1` 的记录数）、`lastSuccessAt`、`errorCode`。不含 cookie 或正文。界面把"在线"改为"上次成功同步时间"，删除"本地游标"一项（它是本地界面变更流的序号，与同步无关）。

服务状态事件 `autonote://sync-status`/`autonote://mcp-status` 只给宿主设置页；领域变化仍走 library-changed，二者互不代替。MCP 返回的引用 URL 使用 `autonote://note/<id>` 稳定标识，不是公开 HTTP 分享，22 的 MCP 客户端说明会写明这一点。

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

### D5-1 新 schema 与迁移

- **改动范围**：`core/src/db/migrations.rs` 新版本 7、`core/src/sync/migrate_v7.sql`（v3 的 `schema.sql` 已发布，不修改）、`core/src/sync.rs` 的绑定读写。
- **步骤**：1. 新增迁移：建 `sync_binding`、`sync_item`、`sync_attachment`；把旧 `sync_state` 当前行搬入 `sync_binding`；删除旧 6 张同步表。2. 为已有的笔记、文件夹、手动标签补 `sync_item`：已绑定且旧 `sync_map` 同 id 已确认时写 `remote_rev`、`dirty=0`，其余 `dirty=1`。3. 旧 `sync_map` 有本地不存在的笔记时（旧引擎推进了游标却没写入），游标归 0，下一轮走全量快照补回。4. 保留现有 DPAPI/密钥环加密和 cookie 校验。
- **判据**：从当前用户库（`sync_state` 一行、游标 13，`sync_map` 3 条笔记映射但本地只有 1 条笔记且都不在映射里）迁移后，站点、账户、cookie 密文保留，游标归 0，本地那条笔记 `dirty=1`；未绑定库全部 `dirty=1`；迁移重复执行无变化。
- **陷阱**：不得在迁移里解密 cookie；只搬密文。

### D5-2 写入层登记脏标记

- **改动范围**：`core/src/write/mod.rs`（`ChangeSet.touched` 记录本事务触及的笔记、文件夹、标签 id，取代 `folders_changed`/`tags_changed`）、`core/src/db/mod.rs` 的 `Library::write`、文件夹/标签写函数。
- **步骤**：1. 笔记的 `record_change`、彻底删除，以及文件夹/标签的 `record` 把 id 记入 `changes.touched`；不经过这些函数的批量写（导入、MCP“删除并上移”）显式记录。2. `Library::write` 提交前，`origin != Sync` 时对 `changes.touched` 写 `sync_item.dirty=1`。3. 提交后宿主的 ChangeSink 唤醒同步循环。
- **判据**：UI、MCP、导入、版本恢复、复制、清空回收站每条路径各一个测试，写入后对应 `sync_item.dirty=1`；`WriteOrigin::Sync` 写入后不变。
- **陷阱**：不要在各个写函数里分别登记，只在 `Library::write` 一处登记；漏掉的路径就是丢数据。

### D5-3 绑定与解绑

- **改动范围**：`sync/src/service.rs` 的 `preview`/`confirm`/`unbind`、`core/src/sync.rs` 的 `sync_bind`/`sync_unbind`、`DesktopSyncSection.svelte`、IPC 校验。
- **步骤**：按 §6.4 实现单一的合并绑定和解绑；删除三种策略、隔离队列、导出/丢弃隔离队列的 command 和界面。
- **判据**：本地 2 条、远端 3 条、其中 1 条 id 相同但内容不同：绑定后本地 4 条笔记（含 1 份冲突副本）、远端在第一次推送后也是 4 条；取消预览不写任何数据；解绑后本地数据不变、全部待推送。

### D5-4 拉取

- **改动范围**：`sync/src/pull.rs`、`core/src/sync.rs` 的 `sync_apply`。
- **步骤**：按 §7.2 实现。增量与全量快照走同一个 `sync_apply` 事务；文件夹、标签、删除真正写入本地；脏记录不覆盖。
- **判据**：远端改正文、改文件夹名、删标签、删笔记，分别在本地生效；本地脏笔记不被远端覆盖；游标为 0 的全量拉取写入全部笔记（回归：原实现写入 0 条）；拉取中途失败游标不变，重跑结果一致。

### D5-5 推送与冲突

- **改动范围**：`sync/src/push.rs`、`core/src/sync.rs` 的 `sync_dirty`/`sync_settle`/`sync_fork_conflict`。
- **步骤**：按 §7.3 的顺序和请求表实现；按结果表处理 200/409/404/401/429/其他 4xx。
- **判据**：桌面新建、修改、移到回收站、恢复、彻底删除，分别在 Web 端可见；两端同时改同一笔记，桌面推送后两端都有原笔记（Web 版本）和冲突副本（桌面版本）；推送请求发出后、响应前本地再次编辑，推送成功后仍为 `dirty=1` 且下一轮推送新内容；响应丢失后重试不产生重复笔记。

### D5-6 附件

- **改动范围**：`sync/src/attachments.rs`、`core/src/sync.rs` 的 `sync_attachment_map`、`core/src/files.rs`。
- **步骤**：按 §7.5 实现上传、丢响应恢复、下载；把 `files_recover` 从每轮同步中移除，只在库打开时执行。
- **判据**：桌面插入图片后 Web 端能显示；Web 端插入图片后桌面能显示且本地正文是本地 id；上传响应丢失重试后远端最多多一个孤立文件、笔记引用唯一；同步一轮的日志里不再出现 `attachment.recovery.completed`。

### D5-7 调度、状态与真实验收

- **改动范围**：`sync/src/service.rs` 的 `start`/`stop`/`run`、`src/lib.rs` 启动流程、`DesktopSyncSection.svelte`、`desktop/src/lib/ipc/validation.ts`、中英文文案。
- **步骤**：按 §7.6 和 §8.2 实现单循环、写入唤醒、开机自动启动、错误持久化和日志、新 `SyncStatus`。
- **判据**：连续点击"启动同步"5 次只有一个循环；有绑定时重启应用自动同步；断网时状态显示错误码并持续保留，恢复后自动清除；WebSocket 连接失败时同步间隔不小于退避值（回归：原实现约每 2 秒一轮）；真实桌面 + 本地 Worker 走完：绑定、双向编辑、冲突、断网恢复、附件、解绑再绑定，记录实际结果。

## 10. 交付检查清单

1. D4-1 的 `rmcp` 实际版本、feature、MSRV、许可证和 `cargo metadata --locked` 证据已记录；没有手写协议路径。
2. 34 个工具逐项具备输入 schema、结果字段、scope、幂等语义、危险注解和真实调用证据；云端备份/分享工具未被误纳入。
3. MCP 所有写入均经 `execute_mcp_write` 单事务，幂等结果和领域写入不可分离提交；过期 rev 不静默覆盖。
4. D5 只用 `sync_binding`、`sync_item`、`sync_attachment` 三张表；脏标记只在 `Library::write` 一处登记，`WriteOrigin::Sync` 不登记；游标只在拉取事务里推进。
5. 本地修改不会被拉取覆盖；笔记冲突两份都在且两端可见；文件夹/标签按"后写者胜"处理。
6. cookie 具备 domain/path/过期/Secure/重定向检查，DPAPI/密钥环失败无明文 fallback；日志不含凭据。
7. 同步不改服务端；附件 id 只在请求副本里替换为远端 id，本地正文保持本地 id。
8. D5 七项任务各有可运行的判据测试，并在真实桌面 + 本地 Worker 上记录实际结果；不能把设计完成当成验收通过。
