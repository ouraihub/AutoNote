# 36 请求配置（API 地址旁齿轮）对齐 Cherry 设计及开发规划

> 范围：Aether（`aether-support` Connection、`aether-providers` DTO/store、`aether-chat` 请求与绘图、`packages/ui/src/providers`）+ AutoNote Web（`web/src/worker`）。Web 与桌面同一套 UI 与语义，属于 Aether 通用能力。
> 原则：**弹窗里的每个配置项都必须落库、并被真实请求使用**；没有运行时消费者的字段不做，不做“只显示不生效”的表面配置。

## 1. Cherry 怎么做的（源码根 `E:/docs/AI申请/AI安装配置教程/ai/cherry-studio/src/renderer/pages/settings/ProviderSettings/ConnectionSettings`）

- 入口：`ApiHostFields.tsx:169-179` API 地址输入框右侧齿轮，tooltip“配置 API Host 与自定义请求头”；标题旁“添加端点”（`:101`）打开同一个弹窗。
- 弹窗 `ProviderCustomHeaderDrawer.tsx`，标题“请求配置”，底部“取消 / 保存”（**批量保存**，`:292-370`）：
  1. 端点列表（`:422-477`）：每个协议一行，标签 = 协议名，默认那条带“默认”徽标，其余可“设为默认”；默认端点下方提示“自定义 API 请求地址；留空则使用目录默认地址”。
  2. “+ 添加端点”（`:479-499`）：虚线整宽按钮，弹出协议列表，给同一服务商再加一个协议的地址。
  3. 图像生成 Base URL / 图像编辑 Base URL（`ProviderImageEndpointFields`）：用于 `/images/generations`、`/images/edits`，留空时使用默认对话端点的 Base URL。
  4. 自定义请求头（`:510-606`）：键值列表 ⇄ JSON 编辑切换，“添加请求头”，每行删除；JSON 非法 toast“JSON 格式错误”。
- 保存校验：默认地址必填且合法；其余非空地址必须合法；JSON 必须是对象。保存后若默认地址变化则后台同步模型。

## 2. 映射到我们的模型

Cherry 一个服务商下按协议挂多个端点；我们是一个服务商下多条**线路**，每条线路一个协议、一个地址、自己的密钥和模型。

| Cherry 配置项 | 我们 | 存储 | 运行时消费者 |
| --- | --- | --- | --- |
| 端点地址 + 协议标签 | 本线路的 协议 + API 地址 | 已有 `endpoints.protocol / base_url`（Web `ai_endpoints` 同） | 已有：聊天、绘图、探测 |
| 默认徽标 / 设为默认 | 只显示“默认”徽标（一条线路只有一个地址） | 不需要 | — |
| 添加端点 | 添加线路（已有 `onaddendpoint`） | 已有 | 已有 |
| 图像生成 Base URL | **新增** 本线路的图像生成地址 | **新增列 `image_base_url TEXT NULL`** | 绘图 `/images/generations`（桌面 `painting.rs`、Web `painting.ts`） |
| 图像编辑 Base URL | 已在 docs/37 随改图功能一起实现 | 新增列 `image_edit_base_url`（桌面 v7、Web v25） | 改图 `/images/edits` |
| 自定义请求头 | **新增** 本线路的自定义请求头 | **新增列 `headers TEXT NOT NULL DEFAULT '{}'`**（JSON 对象） | 聊天每一轮、绘图、探测/同步模型 |

结论：**需要改表**，两端各加两列；不加列就会出现“填了保存但没存上”的情况。

## 3. 数据与接口

### 3.1 存储

- 桌面 `aether-providers/src/store.rs` 迁移 **v6**：
  ```sql
  ALTER TABLE endpoints ADD COLUMN image_base_url TEXT;
  ALTER TABLE endpoints ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';
  ```
- Web `web/src/worker/db/schema.ts`：`SCHEMA_STATEMENTS` 的 `ai_endpoints` 加 `image_base_url TEXT, headers TEXT NOT NULL DEFAULT '{}'`；迁移 **v24** 两条 `ALTER TABLE ai_endpoints ADD COLUMN …`（`skipIfColumnExists: { table: 'ai_endpoints', column: 'image_base_url' }`，新库建表时已有列）；`REQUIRED_COLUMNS.ai_endpoints` 加两列。
- 请求头以明文 JSON 存（与 Cherry 一致）；**密钥必须用 API 密钥功能**，不写进请求头（见 §3.3 保留名）。

### 3.2 DTO（`aether-providers/src/dto.rs`，`pnpm kit:dto` 生成 TS）

```ts
type Endpoint     = { …现有, imageBaseUrl: string | null; headers: Record<string, string> }
type EndpointSave = { …现有, imageBaseUrl?: string | null; headers?: Record<string, string> }  // 省略 = 保持原值
```

整份 `ProviderSave` 保存时随线路一起提交（沿用现有 `save`）；不新增接口。

### 3.3 校验（两端同规则，错误用现有 `bad_request(field, reason)`）

| 字段 | 规则 | 错误 |
| --- | --- | --- |
| `imageBaseUrl` | trim；空串 → null；非空须 `http(s)://`、≤ 2048 字节 | `bad_request("imageBaseUrl","invalid_url")` |
| `headers` 数量 | ≤ 20 | `bad_request("headers","too_many")` |
| 名称 | trim 后为 HTTP token（`^[!#$%&'*+.^_\`|~0-9A-Za-z-]{1,100}$`），大小写不敏感去重 | `bad_request("headers","invalid")` |
| 值 | ≤ 2048 字符，不含 `\r` `\n` | `bad_request("headers","invalid")` |
| 保留名（不区分大小写） | `authorization`、`x-api-key`、`anthropic-version`、`host`、`content-type`、`content-length`、`accept`、`connection`、`transfer-encoding`、`cookie` | `bad_request("headers","reserved")` |

### 3.4 运行时

- `aether_support::Connection` 加 `headers: Vec<(String, String)>`、`image_base_url: Option<String>`（`Debug` 只打印请求头个数，不打印值）。`store.resolve` / `endpoint_connection` 填入；`image_base_url` 同样经过 `api_base` 规范化。
- 请求头施加顺序：**先自定义头，后系统头**（鉴权、`anthropic-version`、`content-type`、`accept`），系统头不会被覆盖（保留名已在保存时拒绝，这里是双保险）。
  - 桌面：`aether-chat/src/protocol.rs` `Request::encode`、`painting.rs`、`aether-providers/src/probe.rs` `fetch`。
  - Web：`runs.ts` `streamRound`、`painting.ts`、`providers.ts` 探测；合并为 `{ ...connection.headers, ...authHeaders(...), accept, 'content-type' }`。
- 绘图地址：`image_base_url ?? base_url` + `/images/generations`。
- 探测（检测/同步模型）：`saved` 与带 `endpointId` 的 `draft` 都用该线路已存的请求头。

## 4. UI（Aether `packages/ui/src/providers/`）

新文件 `RequestConfigDialog.svelte`，替换 `EndpointPanel.svelte` 里现有的“线路设置”对话框（L386-422）。

```
请求配置                                         ✕
协议  [openai-chat ▾]
API 地址  (默认)
[ https://api.fenno.ai/v1                    ]
自定义 API 请求地址：POST https://…/chat/completions
[ ＋ 添加线路 ]                    ← 虚线整宽，关闭弹窗并调用 onaddendpoint
图像生成 Base URL
[ Base URL：https://example.com              ]
用于 /images/generations；留空时使用 API 地址
自定义请求头                 { }   ← 列表 ⇄ JSON 切换
[ 请求头名称 ][ 请求头取值 ] 🗑
＋ 添加请求头
───────────────────────────────────────────────
[删除线路]                          [取消] [保存]
```

- 入口：API 地址右侧齿轮（`Settings2Icon` 保留），`title/aria-label` = “配置 API 地址与自定义请求头”。“添加线路”链接维持现状。
- 打开时把线路当前值拷进本地草稿；**取消**丢弃；**保存**前端预检（地址格式、请求头 JSON/名称/保留名），通过后写回线路草稿并调用 `oncommit()`，成功关闭；后端错误按 reason 映射文案，弹窗保持打开。
- 协议在弹窗内改动后同样只在保存时提交（之前是选中即提交）。
- 地址输入框在面板与弹窗两处都可改，保存后两处一致。
- 删除线路保留在弹窗左下（沿用现有确认框）。
- 组件：现有 `Dialog`、`Field`、`Input`、`Select`、`Button`、`Textarea`；无新依赖。

### 4.1 i18n（en / zh-CN 同步）

| key | zh-CN |
| --- | --- |
| `providers.request_config` | 请求配置 |
| `providers.request_config_tip` | 配置 API 地址与自定义请求头 |
| `providers.default` | 默认 |
| `providers.base_url_hint` | 自定义 API 请求地址：{url} |
| `providers.image_base_url` | 图像生成 Base URL |
| `providers.image_base_url_hint` | 用于 /images/generations；留空时使用 API 地址 |
| `providers.headers` | 自定义请求头 |
| `providers.headers_add` | 添加请求头 |
| `providers.header_name` | 请求头名称 |
| `providers.header_value` | 请求头取值 |
| `providers.headers_to_json` | 切换为 JSON 编辑 |
| `providers.headers_to_list` | 切换为键值列表 |
| `providers.headers_invalid_json` | JSON 格式错误 |
| `providers.headers_invalid` | 请求头名称或取值无效 |
| `providers.headers_reserved` | {name} 由系统设置，不能自定义 |
| `providers.headers_too_many` | 最多 20 个请求头 |

删除不再使用的 `providers.endpoint_settings`。

## 5. 执行

1. Aether 后端：`connection.rs` 两字段 → `dto.rs` → `store.rs` v6 + 校验 + 读写 + resolve → `protocol.rs` / `painting.rs` / `probe.rs` 施加请求头与图像地址 → `pnpm kit:dto`。测试：v5 库升级；保留名/非法名/超量拒绝；请求头与图像地址保存后读回；聊天、绘图、探测的上游收到自定义头且鉴权头不被覆盖；绘图用 `image_base_url`。
2. Aether UI：`RequestConfigDialog.svelte`、`EndpointPanel` 接线、`draft.ts` 的 `toSave` 带上两字段、i18n、`providers.test.ts`（保存前不提交、取消不提交、保留名不提交、JSON 切换往返）。
3. Aether `docs/11-详细设计-kit-providers.md` 补两列与规则；`pnpm run ci`；提交推送。
4. AutoNote Web：schema v24、`providers.ts` 读写与校验、`runs.ts` / `painting.ts` / 探测施加；`web/tests` 对应用例；改 4 处 pin；`pnpm run ci`。
5. 验收（Web 7712 + 桌面打包，真实操作，上游用本地回环服务看收到的请求头）：
   - 保存后刷新/重启，地址、图像地址、请求头都在。
   - 聊天、同步模型、绘图请求都带上自定义头；`Authorization` 仍是密钥。
   - 绘图请求打到图像生成地址；清空后回到 API 地址。
   - 填 `Authorization` 作为请求头 → 提示“由系统设置，不能自定义”，不保存。
   - 取消不保存；JSON 非法提示且不保存；列表 ⇄ JSON 切换内容一致。
