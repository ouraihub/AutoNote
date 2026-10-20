# 41 模型设置对齐 Cherry 设计及开发规划

> 范围：Aether（`aether-providers`、`aether-chat`、`aether-support`、`tauri-plugin-aether`、`packages/ui`）+ AutoNote（`web/src/worker`、`packages/app`、`desktop/src-tauri`）。Web 与桌面同一套语义。
> 目标：模型设置弹窗达到 Cherry“编辑模型”的信息量，且**每个控件都有完整交互链路**：控件 → 保存 → 存储 → 读取 → 运行时 → 用户可见的效果。链路走不通的控件不做；现有控件里链路断了的先修。
> 路径缩写：A = `D:/workspace-ai/music-dev/Aether`，N = 本仓库，C = `D:/workspace-ai/music-dev/cherry-studio/src`。本文结论来自读代码，未运行。

## 1. Cherry 怎么做的

| 区块 | 位置（C） | 存储 | 运行时消费者 |
| --- | --- | --- | --- |
| 模型 ID（只读+复制） | `renderer/.../ModelDrawer/ModelBasicFields.tsx` | `apiModelId` | 请求 |
| 模型名称 / 分组名称 | 同上 | `name` / `group` | 选择器、模型列表分组；消息头在发送时快照名称 |
| 模型用途 对话/图像生成/图像编辑 | `ModelPurposeFields.tsx`、`modelPurpose.ts:121-160` | `endpointTypes` + `capabilities` + 模态 | 路由到文本或图像接口 |
| 模型类型 文本/图片/嵌入/重排 | `ModelClassificationControls.tsx`、`helpers.ts` | `capabilities[]` | 选择器过滤 |
| 模型能力 推理/工具 | 同上 | `capabilities` | 工具注入；推理档位来自 `model.reasoning`，弹窗不编辑 |
| 输入模态 视觉/音频/视频 | 同上 | `inputModalities[]` | 原生附件（`nativeFileSupport.ts:159-162`） |
| 上下文窗口 / 最大输入 / 最大输出 + 快捷芯片 | `ModelContextWindowFields.tsx` | 三个数字 | 上下文预算；最大输出只在 Anthropic 接口上发送 |
| 支持增量文本输出 | `EditModelDrawer.tsx` | `supportsStreaming` | 无 |
| 币种 + 分档价格 | `ModelPricingFields.tsx`、`modelPricing.ts` | `pricing` | 每次请求按当时价格算费用，写入用量记录（`AiUsageRecordService.ts:1201`），历史不重算 |

交互：每个控件失焦/点击即保存（串行队列，同模型的补丁合并）；成功后刷新 `/models` 缓存。

Cherry 交互上的断点，我们不照抄：

- 失败只弹 `common.error`，不回滚，弹窗显示的值和库里不一致。
- 聊天输入栏通过 `useModelById` 读取模型，缓存键不同，保存后不刷新（`useModel.ts:241-246`）；不广播到其他窗口。
- 推理开关对注册表不认识的模型不起作用（没有档位、不发推理参数）。
- 最大输入、增量输出没有运行时消费者；没有 `maxOutput ≤ contextWindow` 校验。
- 改模型类型没有提示，正在使用这个模型的助手仍然绑定着它。
- 名称为空时仍发送旧名称，分组无法清空回推导值。

## 2. 现有设置体检

公共链路：`ModelSettingsDialog` 保存 → `EndpointPanel.setModels` → `ProvidersSettings.commit()` 整个服务商一起保存（桌面 `providers_save`，Web `PUT /api/ai/kit/providers`）→ 删除后重新插入该线路的所有模型 → 成功后 `providersRevision++` → 同一页面里的 `ChatPanel`、`ModelSelect` 重新拉取 `modelOptions`。每次运行开始时 `resolve` 一次连接配置（桌面 `chat.rs:343`，Web `runs.ts:211`），正在进行的运行不受影响，**下一轮**生效。

| 设置 | 运行时效果 | 用户可见 | 断点 |
| --- | --- | --- | --- |
| 可看图（对话） | 不支持时拒绝当前图片，历史图片不发送（`validate.rs`、`runs.ts:246-253`） | 附件按钮禁用 | 关闭后，托盘里已有的图片导致无法发送，界面没有提示（`ChatPanel.svelte:579`） |
| 支持参考图（图像） | `generate_image` 是否带 `image_ids`（`tools.rs:101`、`runs.ts`） | 能否改图 | 无 |
| 联网 | 聊天栏地球按钮打开时，在 `tools[]` 里加入原生搜索 | 请求体变化 | 协议切换到 openai-chat 时，`toSave` 会静默清掉该值 |
| 思考协议/档位/预算 | 生成 `reasoning_effort`/`reasoning`/`thinking` 参数（`protocol.rs:91-125`、`protocol.ts:313-322`） | 聊天栏的档位滑块 | **选“未知”不生效**：保存为 NULL，读取时又重新推断出来（A `store.rs:906-915`，Web `providers.ts:322-324`），界面会弹回原值；可以构造出后端拒绝的值（档位全不选、预算 < 1024、预算 ≥ 最大输出），结果只有笼统的提示“请求无效”，而且**之后这个服务商的每次保存都会失败** |
| 上下文窗口 | 预算检查、历史裁剪 | 上下文 % 计量 | 不校验是否大于最大输出，运行时才报 `budget_exceeded` |
| 最大输出 | `max_tokens`/`max_output_tokens`，历史裁剪 | 请求体 | 接受 0；上游返回 400 |
| 工具（不可编辑） | 为 `false` 时拒绝 `generateImage`（`chat.rs:497`、`runs.ts:212`）；为 `null` 时桌面在被拒后不带工具重试（`run.rs:173-181`），Web 不重试 | “生成图片”按钮禁用 | 重新探测时总被探测值覆盖（`ModelPickerDialog.svelte:88`）；已打开的生成图片开关不会随之关闭，下次发送报 `tools_unsupported` |
| 模型类型（只能在添加模型时改） | 对话/绘图模型的选择 | 选择器过滤 | 选择器从 chat 改到 image 时保留了 reasoning，保存被拒（`ModelPickerDialog.svelte:85`）；`typeSource` 没有运行时消费者 |

另外两处会影响所有设置：

- 任何一次保存服务商，`ChatPanel` 都会把 `modelOptions` 先置为 null，导致用户选的思考档位被重置为 `default`（`ChatPanel.svelte:120,138-140`），改的是无关模型也一样。
- 其他浏览器标签页、其他设备收不到 `providersRevision`：重新挂载前它们的界面状态是旧的，但请求在服务端重新 resolve，所以请求本身是对的。

## 3. 新增与改造：每项的完整链路

每项都按“控件 → 存储 → 读取 → 运行时 → 可见效果 → 前置修复”列出。前置修复没做完，这一项就不上线。

### 3.1 模型名称 `name`

- 控件：文本框，placeholder 为 id；trim，空串保存为 null（可以清空，回到显示 id；这一点不照抄 Cherry）。
- 存储：桌面 `models.name`，Web `ai_models.name`；`write_endpoint`（A `store.rs:870-883`）和 `saveProvider`（N `providers.ts:520-527`）的 INSERT 加上这一列。
- 读取：`Model.name`；**`ModelOption` 增加 `name` 字段**（A `dto.rs:~280`，N `providers.ts:621,649-661`）。`label` 不变，仍是 `{provider} · {slug} · {modelId}`。
- 显示位置（`name ?? id`）：

| 位置 | 文件 |
| --- | --- |
| 选择器按钮、列表行、头像 | A `ModelSelect.svelte:131,186-187` |
| 选择器搜索：同时匹配 name 和 id | `ModelSelect.svelte:182` |
| 模型列表行与搜索 | A `EndpointPanel.svelte:119,342-374` |
| 回复来源行 | A `ChatPanel.svelte:339-344` 已经用 label，改为用 name |
| 写作角色“跟随对话（X）” | 桌面 `commands/ai.rs:124-130` 已经用 label；**Web `routes/ai.ts:52` 用的是原始 id，要改成一致** |

- 前置修复：`ModelSelect.svelte:52-53` 从 label 末尾切掉 ` · modelId` 得到分组标题。只要 label 里不再是 modelId，每个模型就会变成单独一组。label 保持原样，并且把分组改为直接用 `provider · slug`。
- 生效：保存后 `providersRevision` 触发，同一页面里立即生效。历史消息的来源行跟随当前名称（我们不像 Cherry 那样在发送时快照名称；模型被删除后回退显示 `endpointId · modelId`，这是现状）。

### 3.2 分组名称 `groupName`

- 控件：文本框，placeholder 为按 id 推导出的前缀；空串保存为 null，回到推导值。
- 存储与读取：同 `name`（`models.group_name`）。
- 消费者：只有模型列表的分组键 `groupName ?? 前缀推导`（A `EndpointPanel.svelte:122,323`）。`ModelSelect` 按服务商线路分组，是另一个概念，不改。
- 探测：`ModelPickerDialog.emit()`（`:76-92`）对新模型带上 `ProbedModel.group`，已有的模型保留用户的 `groupName`。

### 3.3 模型用途 / 模型类型（可编辑）

- 控件：用途单选（对话 / 图像生成 / 图像编辑），仅当 `modelType ∈ chat|image` 时显示；类型芯片（文本 / 图片 / 嵌入 / 重排 / 其他▾）。它们映射到已有字段，不新增列：对话 = `chat`；图像生成 = `image` + `canVision=false`；图像编辑 = `image` + `canVision=true`。改类型时写 `typeSource='user'`。
- 联动：类型离开 chat 时，在弹窗里把 `reasoning` 置为 null、`nativeWebSearch` 置为 false（否则后端拒绝保存，这正是 `ModelPickerDialog.svelte:85` 现在的 bug，一并修掉）。
- 运行时：对话选择（桌面 `lib.rs:347`，Web `runs.ts:158`）、绘图角色（`runs.ts:289`）、选择器过滤。
- 前置修复（角色引用）：
  - **Web `listRoles`（N `routes/ai.ts:43-57`）不检查类型**，类型改掉后角色仍指向这个模型；app 里的 `ChatPanel.svelte:21` 据此认为“生成图片”可用，发送时报 `needs_config painting_model`。改为和桌面 `effective_roles`（`commands/ai.rs:65-101`）一致：类型不符就隐藏该绑定。
  - app 里的 `ChatPanel.svelte:12-24` 只在挂载时计算一次绘图开关，要在 `providersRevision` 变化时重新计算。
  - 当前选中的模型变得不可用时，桌面静默回退到角色模型（`lib.rs:357-368`），Web 返回 `needs_config(model)`。统一为 Web 的行为：明确报错，不悄悄换模型。
  - 弹窗提示：如果被改类型的模型正被角色使用，在类型芯片下显示“对话/写作/绘图角色正在使用此模型，修改后需重新选择”（角色列表由宿主传入，Aether UI 不感知 AutoNote 的角色，用一个可选 prop `usedBy: string[]`）。

### 3.4 工具能力（可编辑）

- 控件：“工具”芯片，三态：未选中且标注“未探测”= `null`；选中 = `true`；再点一次 = `false`。
- 运行时：为 `false` 时拒绝 `generateImage`，桌面还会丢弃全部工具（`validate.rs:143`）；为 `null` 时桌面在被拒后去掉工具重试。
- 前置修复：
  - 重新探测时保留用户的值（`ModelPickerDialog.svelte:88`）。
  - 聊天栏：`capability.supportsTools` 变成 `false` 时，把已打开的“生成图片”开关关掉（`ChatPanel.svelte:963,1068` 目前只禁用按钮，不改状态）。
  - Web 补上桌面的 `null` 重试（`runs.ts` 中遇到上游拒绝工具时去掉工具重发一次），否则“未探测”在两端含义不同。
- 更正：上一版写的“Web 在 `false` 时仍注入工具”是错的。Web 唯一的工具是 `generate_image`，`false` 时会先在 `runs.ts:212` 被拒绝。

### 3.5 推理（改造）

- 控件：“推理”芯片。打开 = 展开现有的协议、档位、预算控件；关闭 = 不推理。
- 前置修复（“未知”不生效）：NULL 同时表示“未设置，走推断”和“用户关掉了推理”，读取时会被重新推断出来。改为：**用户关闭推理时，`reasoning` 列存字面量 `'none'`**，读取时视为 `reasoning = null`，并且不再推断；NULL 仍表示走推断。不加列，不加新的 dialect；两端各有唯一的读取函数（桌面 `read_reasoning`，Web `readReasoning`），list / resolve / modelOptions 都走它。
- 前置修复（推断值被写进库）：弹窗打开时拿到的是推断值，任何一次保存都会把它固化成用户值。`toSave` 规则：已保存过的模型，`reasoning` 与上次保存的值相同就省略；新模型的 `reasoning` 为 null 时也省略（`ModelSave.reasoning` 三态：省略 = 保持，`null` = 关闭，对象 = 替换）。省略时后端仍会按新的协议和最大输出重新校验保留的值。
- 前置修复（无效值卡住保存）：见 §4.2 弹窗内校验。
- 前置修复：保存服务商时不要重置思考档位。`ChatPanel.svelte:120` 不要先置为 null；新的 options 到达后，只有当当前档位不在 `allowedEfforts` 里时才回退到 `default`。

### 3.6 上下文窗口 / 最大输出（快捷芯片）

- 控件：芯片只是帮忙填数字（上下文 128000/200000/262144/400000/524288/1000000；最大输出 16384/32768/65536/131072），与当前值相等的芯片高亮；输入框可以清空，清空为 null，运行时使用默认值（32000 / 4096）。输入框 placeholder 显示这两个默认值。
- 校验（弹窗内 + 两端后端）：两个值都 ≥ 1；`maxOutput < contextWindow`；推理预算 `< maxOutput`。后端错误码：`bad_request("maxOutput","exceeds_context")`、`bad_request("maxOutput","invalid")`。
- 运行时：现有链路不变。

### 3.7 价格与费用（阶段 2）

- 控件：币种（$ / ¥）、档位（起点 + 输入/输出/缓存读/缓存写，每百万 Token）、添加/删除档位。仅对话模型显示。
- 存储：`models.pricing` JSON；回合表加 `cost REAL`、`cost_currency TEXT`。
- 运行时：`Connection.pricing`。**每一轮请求**按该轮用量计算费用并累加（同一回合的工具循环可能跨过档位边界，按回合总量选档会算错）：Web 在 `runs.ts:343` 的 `roundUsage`，桌面在 `run.rs:44` 的 `Usage::add`。回合结束时写入库，之后改价不重算历史。
- 可见效果：回复下方用量详情里显示“费用 $0.0123”，对话合计按币种分别求和。实时显示需要在运行结束事件里带上 `cost`（桌面在 `chat.rs:766` 计算，晚于 `RunEvent::Usage`；Web 是 `runs.ts:~375`），否则要重新打开对话才能看到。
- 前置修复（**阻塞**）：桌面的用量解析不完整（A `protocol.rs:459,483-484,504-505`）：
  - Anthropic 只读取 `message_start.input_tokens`，不含缓存，`cache_read_input_tokens`/`cache_creation_input_tokens` 不解析；
  - OpenAI Chat 和 Responses 不解析 `cached_tokens`、推理 Token；
  - 测试把这些字段固定为 None（`aether-chat/src/tests.rs:470-481`）。
  - 这违反了 docs/18“输入包含缓存”的约定，也让桌面现在的用量显示少算。按 Web `protocol.ts:137-143,180-185,213-218` 的做法补齐。
- 费用公式（Rust `aether-support` 一份，TS 一份，用共享 fixture 保证两边一致，同 `model-classify.json`）：

```
tier     = 最后一个 minInputTokens ≤ 本轮 inputTokens 的档
uncached = max(0, input − cacheRead − cacheWrite)
cost     = (uncached·tier.input + cacheRead·(tier.cacheRead ?? tier.input)
          + cacheWrite·(tier.cacheWrite ?? tier.input) + output·tier.output) / 1e6
```

- 某一轮缺少 input 或 output Token → 整个回合 `cost = null`，不显示（宁可不显示，也不显示一个偏低的数字）。
- 对话合计：`cumulativeUsage`（`run-session.svelte.ts:102-115`）现在会把同一会话里所有分支和候选回复都加进去。费用合计沿用同一口径，标注为“本会话合计”。

### 3.8 不做

| 项 | 原因 |
| --- | --- |
| 音频/视频输入 | 两端都不发送音频/视频，开关不会改变任何请求 |
| 最大输入 Token | Cherry 也没有运行时消费者；我们的预算 = 上下文窗口 − 最大输出 |
| 支持增量文本输出 | 三种协议都只实现了流式；Cherry 的这个开关也不生效 |
| 按图片计价 | 绘图没有用量记录可以挂靠 |
| 汇率换算 | 合计按币种分开显示 |

### 3.9 接口汇总

```ts
type Model = { …现有,
  name: string | null; groupName: string | null      // 阶段 1；trim，空串→null，≤80 字符
  pricing: ModelPricing | null }                     // 仅 chat
type ModelOption = { …现有, name: string | null }
type ModelPricing = { currency: 'USD' | 'CNY'; tiers: PricingTier[] }   // 1..8 档，tiers[0].minInputTokens = 0，严格递增
type PricingTier = { minInputTokens: number; input: number; output: number; cacheRead: number | null; cacheWrite: number | null }
// Turn / 运行结束事件（阶段 2）
cost: { amount: number; currency: 'USD' | 'CNY' } | null
```

存储（一次迁移）：桌面 `providers.db` v10（`models.name`、`group_name`、`pricing`）、chat store v6（`turns.cost`、`cost_currency`）；D1 v28（`ai_models` 三列 + `ai_chat_turns` 两列），Web 备份列清单（`schema.ts:765-768`）同步。

校验错误码（桌面、Web、弹窗三处一致）：`name|groupName too_long`；`contextWindow|maxOutput invalid`（< 1）；`maxOutput exceeds_context`；`reasoning invalid_efforts|protocol_mismatch|invalid_budget|unexpected_budget`；`pricing invalid`。

## 4. 交互

### 4.1 保存方式

保留“取消 / 保存”，不做失焦即保存。理由：整个服务商一起保存，保存失败时整个草稿都不会写入；而失焦保存在 Cherry 那里正是导致界面与数据不一致的原因。

### 4.2 弹窗内校验（前端先拦，后端兜底）

| 条件 | 提示（显示在字段下方） | 保存按钮 |
| --- | --- | --- |
| 推理打开但档位全不选 | 至少选择一个档位 | 禁用 |
| 预算 < 1024 或为空（anthropic-budget） | 预算至少 1024 | 禁用 |
| 预算 ≥ 最大输出（含最大输出为空时的默认值 4096） | 预算必须小于最大输出 | 禁用 |
| 最大输出 ≥ 上下文窗口（空值按默认值计算） | 最大输出必须小于上下文窗口 | 禁用 |
| 数字 < 1 或不是整数 | 请输入正整数 | 禁用 |
| 价格 < 0 或不是有限数；档位起点不递增 | 同 Cherry 的提示 | 禁用 |
| 名称/分组 > 80 字符 | 最多 80 个字符 | 禁用 |

校验逻辑放在 `packages/ui/src/providers/draft.ts`，返回 `{field, reason}[]`，与后端 reason 一一对应，后端也按同样的规则校验。

### 4.3 保存失败

- 后端错误按 `field + reason` 显示（i18n `providers.error.<field>.<reason>`），例如“预算必须小于最大输出”，而不是笼统的“请求无效”。
- 失败时保存横幅显示“模型 X 的设置无效：<原因>”（模型取自错误的 `details.entity`，没有时按本地规则重新校验找出来），不能静默地一直保存失败。
- 重新打开弹窗显示草稿值；后端规则在弹窗里有同样的实现（`draft.ts` 的 `validateModel`），出错字段会直接显示提示，不另存“上次错误”。

### 4.4 生效时机（写进弹窗底部的说明）

“保存后从下一条消息开始生效；正在生成的回复不受影响。”

| 位置 | 刷新方式 |
| --- | --- |
| 同一窗口的聊天面板、选择器、角色设置 | `providersRevision`（已有） |
| 聊天面板的绘图开关、生成图片开关、思考档位 | 本文新增的 `providersRevision` 订阅（§3.3/§3.4/§3.5） |
| 其他标签页/设备 | 不做实时推送；它们的请求在服务端重新 resolve，所以结果正确，界面要重新进入才会更新 |

## 5. 执行

阶段 0（修现有断点）：

1. Aether：推理 `'none'` 语义 + 唯一读取函数；`toSave` 省略未改动的值；`maxOutput`/`contextWindow` 后端校验与错误码；`ModelPickerDialog` 保留用户的 `supportsTools`，类型切换时清理 `reasoning`/`nativeWebSearch`；`ChatPanel` 不再重置档位、生成图片开关跟随 `supportsTools`；弹窗内校验 + 按字段显示错误；桌面用量解析补齐缓存与推理 Token。测试：每一条断点各一个先失败后通过的用例。
2. AutoNote：Web 后端同样的校验；`listRoles` 检查类型 + 使用 label；`runs.ts` 增加 `null` 工具重试；桌面统一“选中的模型不可用 → 报错”；app `ChatPanel` 的绘图开关订阅 revision；改 4 处 pin；`pnpm run ci`。

阶段 1（模型元数据与弹窗重排）：

3. Aether：`name`、`groupName`，`ModelOption.name`，`ModelSelect` 分组不再依赖 label 末尾是 modelId；弹窗按 §3 重排（ID 复制、名称、分组、用途、类型、能力芯片、快捷芯片、`usedBy` 提示）；`pnpm kit:dto`。
4. AutoNote：zod `ModelSchema`、`providers.ts` 读写、导出列；AiSection 传入 `usedBy`。

阶段 2（价格与费用）：

5. Aether：`pricing` + 校验；`aether-support` 费用函数 + fixture `packages/ui/fixtures/pricing-cost.json`；每一轮累加；回合加 cost 列；`RunEvent::Usage.cost`；`UsageDetails` 显示费用。
6. AutoNote：`runs.ts` 每一轮计算费用（同一 fixture）；`pnpm run ci`。
7. 文档：Aether `docs/11`、`docs/18`；AutoNote `docs/33`。

三个阶段一起实现、一起发版：存储改动合并为 §3.9 的一次迁移，4 处 pin 只改一次。

## 6. 验收（每条都要在桌面和 Web 各跑一次，观察的是请求或界面，不是存储）

| 操作 | 期望 |
| --- | --- |
| 推断出推理能力的模型 → 关闭推理 → 保存 → 重新打开 | 推理仍为关闭；下一轮请求不带推理参数；聊天栏没有档位滑块 |
| 在聊天栏选“高”档位 → 去设置里改另一个模型 → 回到聊天 | 仍为“高” |
| 最大输出设为大于上下文窗口 | 保存按钮禁用，字段下方有提示；绕过前端直接调接口 → 返回 `exceeds_context` |
| 设置名称“我的 Opus” | 选择器、模型列表、回复来源行、写作角色“跟随对话”都显示新名称；按名称和按 id 都能搜到；选择器分组不变 |
| 清空名称 | 回到显示 id |
| 设置分组“常用” | 模型列表出现“常用”分组；清空后回到前缀分组 |
| 把绘图角色使用的模型改为对话 | 类型芯片下出现提示；保存后绘图角色显示“未设置”；聊天栏“生成图片”按钮禁用（不刷新页面） |
| 关闭工具 | 已打开的生成图片开关自动关闭；重新探测后仍为关闭 |
| 用途选“图像编辑” → 再改回“图像生成” | 前者下工具带 `image_ids`，后者不带 |
| 设置价格 $3 / $15，缓存读取 $0.3，发一轮带缓存命中的对话（桌面用 Anthropic，Web 用 OpenAI 各一次） | 用量详情中的费用 = 按回环上游记录的用量手算的值；改价后旧回合费用不变 |
| 两档价格（0 起 / 20 万起），跑一个第二轮请求跨过 20 万的工具循环 | 费用 = 每一轮按各自档位计算后的和 |

## 7. 待定

- 阶段 2（价格）是否要做：前提是先修好桌面的用量解析（阶段 0 已包含）；工作量和阶段 1 差不多。
