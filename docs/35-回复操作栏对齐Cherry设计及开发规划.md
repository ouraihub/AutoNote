# 35 回复操作栏对齐 Cherry 设计及开发规划

> 范围：Aether `packages/ui/src/chat`（`MessageItem.svelte`、`ChatPanel.svelte`、i18n）、`crates/aether-chat/src/store.rs`（桌面删除），AutoNote `web/src/worker/ai/history.ts`（Web 删除）。Web 与桌面同一套 UI 与语义。
> 起因：唯一回复是“已选上下文”，删除与“用作上下文”永远置灰；Cherry 不这样做。

## 1. Cherry 怎么做的（源码根 `E:/docs/AI申请/AI安装配置教程/ai/cherry-studio/src`）

### 1.1 回复操作栏

`renderer/components/chat/messages/frame/messageMenuBarConfig.ts:13-24` 固定顺序（助手消息）：

| 顺序 | 按钮 | 显示条件（`messageMenuBarActions.tsx`） | 文案 |
| --- | --- | --- | --- |
| 1 | 复制 | 总是 | 复制 |
| 2 | 朗读 | 有正文 | 朗读（我们无 TTS，不做） |
| 3 | 重新生成 | 助手消息 | 重新生成 |
| 4 | @ 切换模型 | 助手消息 | 切换模型回答 |
| 5 | 翻译 | 非用户消息 | 翻译 |
| 6 | 设置为上下文 👍 | **仅同一问题有多个回复（`isGrouped`）**；选中时实心主题色 | 设置为上下文 |
| 7 | 保存到笔记 | 助手消息 | 保存到笔记 |
| 8 | 删除 | 总是；仅“生成中 / 未加载”禁用（`useChatWriteActions.ts:202-212`） | 删除 |
| 9 | 更多 ≡ | 非用户消息 | 更多操作 |

流式中禁用：删除、重新生成（`STREAMING_DISABLED_BUTTON_IDS`）。

### 1.2 更多菜单（`messageMenuBarActions.tsx:494-630`，截图一致）

```
编辑            (write, 10)
分支            (write, 20)
复制为新对话    (write, 25)
多选            (write, 30)   ← 我们无多选，不做
──────
保存 ›          保存到本地文件 / 保存到笔记 / 保存到知识库(不做)
──────
导出 ›          导出为 Markdown …（我们只有 Markdown）
```

### 1.3 删除语义（`main/data/services/MessageService.ts:1897-2023`）

- 默认 `cascade=false`：只删这一条，**子消息改挂到继任者**。
- 继任者：被删的是当前上下文且同组还有其他回复 → 同组按时间的下一条，末尾则上一条；否则 → 被删消息的父节点。
- 当前上下文被删 → 新上下文 = 从继任者（或父节点）往下走到**最新的叶子**；只剩根时为空。
- 确认框：`chat.message.confirm_delete` 默认开，标题“确定要删除此消息吗？”，按钮“删除”。

## 2. 我们现在的差异

| 点 | 现在 | Cherry |
| --- | --- | --- |
| 删除 | 当前上下文、或有后续 / 有候选 → 禁用 | 只有生成中禁用 |
| 用作上下文 | 每条回复都显示文字按钮；已选时禁用 + 头部“已选上下文” | 只有多个候选时显示 👍 图标按钮，已选时实心高亮 |
| 顺序 | 复制、更多、重试、@、翻译、删除、保存、插入、用作上下文（靠右） | 复制、重新生成、@、翻译、👍、保存到笔记、删除、更多（最后） |
| 更多菜单 | 编辑回复 / 从此回复创建分支 / 复制为新对话 / 保存为笔记 / 下载 Markdown，平铺无图标 | 编辑 / 分支 / 复制为新对话 ─ 保存 › ─ 导出 ›，带图标与分组 |

## 3. 设计

### 3.1 操作栏（`MessageItem.svelte`）

顺序：复制 → 重新生成（失败时“重试”）→ @ → 翻译 → 👍 设置为上下文 → 保存到笔记 → 删除 → 插入（AutoNote 宿主特有，保留）→ ≡ 更多。

- 👍：`ThumbsUpIcon`，`icon-xs`；`chosen` 时 `fill-primary text-primary` 且 `aria-pressed=true`；仅当同问题回复数 ≥ 2 时传入 `onUseContext`。未完成的回复禁用。
- 去掉头部“已选上下文”文字（Cherry 只用 👍 表示）；保留选中回复的描边，但仅在多候选时显示。
- 删除：`disabled = busy || turn.status === 'running'`；不再有 `deletable / deleteReason`。
- 更多：`Menu` 图标放最后。

### 3.2 更多菜单

shadcn-svelte `dropdown-menu`（基于已依赖的 bits-ui，无新依赖）替换 `<details>`：

```
✎ 编辑
⑂ 分支
⧉ 复制为新对话
──────
💾 保存 ›   保存到本地文件（下载 Markdown） / 保存到笔记（有 onSaveNote）
──────
⇪ 导出 ›   导出为 Markdown
```

图标：`file-pen-line`、`split`、`copy-plus`、`save`、`upload`。编辑只在 `editable` 时可点（仍要求叶子：有后续时编辑会让后续上下文失真，保持现状）。

### 3.3 删除语义（两端同一算法）

删除回复 `T`（非 running）：

1. 继任者 `S`：同 `questionId` 的其他回复（按 `seq`），取 `T` 之后的第一个，没有则之前的最后一个；都没有则 `S = T.parentId`（可能为 null）。
2. 改挂：`parentId = T.id` 的回复 → `parentId = S`；`supersedesId = T.id` → `supersedesId = S`（同组时）或 `null`；`kind='translation'` 且父为 `T` 的译文随 `T` 一起删除（译文只对原回复有意义）。
3. 删除 `T`（以及第 2 步的译文）。
4. 若 `selectedTurnId` 被删 → 从 `S` 往下取最新叶子：反复取 `parentId = 当前` 且 `kind='reply'` 的最大 `seq` 的回复；`S` 为空时取剩余回复中 `parentId = null` 的最大 `seq` 再往下；无剩余回复 → `null`。
5. 一个问题唯一回复被删时问题随之消失（问题与回复同行），其后续轮次改挂到上一轮，对话继续可用。

前端：确认框标题 `chat.deleteReplyTitle`“确定要删除此消息吗？”，按钮“删除”（danger）；正文按是否有后续：有后续 → `chat.deleteReparentBody`“后续对话会接到上一条回复上。此操作无法撤销。”，否则不显示正文。

后端错误：只保留 `turn_running`（running 时）与 `conversation_changed_or_running`；删除 `turn_selected`、`turn_has_dependents`（删除路径）。

### 3.4 i18n（en / zh-CN 同步）

| key | zh-CN | 说明 |
| --- | --- | --- |
| `chat.useContext` | 设置为上下文 | 改文案 |
| `chat.deleteReply` | 删除 | 改文案 |
| `chat.deleteReplyTitle` | 确定要删除此消息吗？ | 改文案 |
| `chat.deleteReparentBody` | 后续对话会接到上一条回复上。此操作无法撤销。 | 新增 |
| `chat.editReply` | 编辑 | 改文案 |
| `chat.branch` | 分支 | 改文案 |
| `chat.saveNote` | 保存到笔记 | 改文案 |
| `chat.save` | 保存 | 新增 |
| `chat.saveFile` | 保存到本地文件 | 新增（原 `chat.exportMarkdown` 动作） |
| `chat.export` | 导出 | 新增 |
| `chat.exportMarkdown` | 导出为 Markdown | 改文案 |
| `chat.more` | 更多操作 | 改文案 |
| `chat.candidateHint` | 原回复将保留。点 👍 设置为上下文后，可从候选回复继续对话。 | 改文案 |

删除：`chat.chosenReply`、`chat.deleteCandidateBody`、`chat.deleteOnlyReplyBody`、`chat.deleteSelectedDisabled`、`chat.deleteChildrenDisabled`。

## 4. 执行

1. Aether `store.rs` `remove_turn` 按 §3.3（先改挂再删，满足 `parent_id`/`supersedes_id` 外键）；更新 `store/tests.rs` 删除用例：删除已选唯一回复 → 上下文回到上一轮；删除已选候选 → 上下文移到同组下一条；删除有后续的回复 → 后续改挂且历史路径完整；译文随原回复删除。
2. Aether UI：`pnpm dlx shadcn-svelte@latest add dropdown-menu`；`MessageItem` 按 §3.1/3.2；`ChatPanel` 去掉 `canDelete/deletionReason`，👍 只在多候选时传；i18n；`chat.test.ts` 改为行为断言（唯一回复可删、单回复无 👍、多回复 👍 选中）。
3. Aether `docs/16-详细设计-kit-ui.md` L119 改写删除规则；`pnpm run check`；提交推送。
4. AutoNote `web/src/worker/ai/history.ts` `removeTurn` 同 §3.3（单个 `db.batch`，含 `mutationGuard`）；`web/tests` 对应用例；改 pin；`web:check`、`web:test`。
5. 验收（Web 7712 + 桌面打包，真实操作）：
   - 唯一回复：无 👍；删除可点，确认后问题与回复消失；再发消息正常。
   - 两个候选：都显示 👍，已选为实心；删除已选的 → 另一条变为已选。
   - 第二轮之后删第一轮回复：第二轮仍在，继续对话时历史只含第二轮。
   - 更多菜单：编辑 / 分支 / 复制为新对话 / 保存 › / 导出 › 与截图一致，键盘可操作，Esc 关闭。
   - 生成中：删除与重新生成禁用。
