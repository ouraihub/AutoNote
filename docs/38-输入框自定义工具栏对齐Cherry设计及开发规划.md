# 38 输入框自定义工具栏（对齐 Cherry）设计及开发规划

> 状态：已确认并实施（2026-10-17）。范围：Web 与桌面共用的 Aether `ChatPanel` 输入框工具栏；AutoNote 负责记住用户设置。

## 1. Cherry 的做法（代码分析）

参考 `cherry-studio/src/renderer/components/composer/variants/shared/`：

- `useComposerToolbarPinnedTools.tsx`：偏好 `chat.input.toolbar.pinned_tools` 是**有序的工具 id 数组**，默认 `['composer:new-conversation', 'web-search']`。同时提供“恢复默认”（与默认相同时禁用）和“自定义工具栏”入口。
- `ComposerToolbarShortcuts.tsx`：
  - 工具栏按 `pinnedIds` 顺序渲染图标按钮。
  - “自定义工具栏”弹层把**所有候选工具放在一个可拖动列表**里，每行依次是：拖动手柄、图标、名称、开关。
  - 开关控制是否放到工具栏；拖动改变顺序，只把已开启项的顺序写回偏好。
  - 底部“恢复默认”。
  - 认不出的旧 id 保留在偏好里，不显示。
- “+”面板（输入快捷面板）底部固定一行“输入快捷面板”和设置图标，点击后打开“自定义工具栏”。

## 2. AutoNote 现状

- `ChatPanel.svelte` 工具栏顺序写死：新对话、联网搜索（有搜索端口时）、“+”。“+”弹层里有上传附件、生成图片。
- Aether UI 没有偏好存储；同类设置（技能 `skills`/`onSkillsChange`）由宿主传入并保存。

## 3. 设计

### 3.1 工具与默认值

| id                 | 名称     | 何时可用                     | 默认在工具栏 |
| ------------------ | -------- | ---------------------------- | ------------ |
| `new-conversation` | 新对话   | 总是                         | 是           |
| `web-search`       | 联网搜索 | 宿主有搜索端口且是聊天       | 是           |
| `attachment`       | 上传附件 | 总是（模型不支持图片时禁用） | 否           |
| `generate-image`   | 生成图片 | 聊天                         | 否           |

不做 Cherry 的知识库、提示词、MCP 和清除上下文：我们没有对应功能。以后加功能时，在同一个列表里加一个 id 即可。

### 3.2 交互

- **工具栏**：按用户顺序显示已开启的工具，“+”固定在最右。行为和原来一致：联网搜索是开关；生成图片是开关并显示 `aria-pressed`；上传附件打开文件选择。
- **“+”面板**：只列**没放到工具栏**的工具，避免同一个按钮出现两次。底部固定一行“输入快捷面板”和设置图标，点击后在同一个弹层里切换到“自定义工具栏”视图。
- **自定义工具栏视图**：
  - 每行依次是：拖动手柄、图标、名称、开关（复用 `components/ui/switch`）。
  - 拖动手柄支持鼠标/触屏（pointer 事件）和键盘：聚焦手柄后按 ↑/↓ 移动一位，按 Esc 关闭弹层。
  - 底部“恢复默认”，与默认相同时禁用。
  - 关闭弹层后，下次打开回到面板视图。
- 当前环境不可用的工具（例如没有搜索端口时的联网搜索）不在列表里显示，但其 id 保留在设置里。

### 3.3 合同（Aether `ChatPanel` props）

```ts
toolbar?: string[]                       // 有序；省略时为默认 ['new-conversation', 'web-search']
onToolbarChange?: (ids: string[]) => void // 宿主决定是否记住；不传时只在本次会话内生效
```

存的是**全部工具的顺序加开关状态**：`toolbar` 只记录开启的 id 及其顺序；关闭项排在开启项之后，保持默认相对顺序。这与 Cherry 一致，只写回开启项。

### 3.4 AutoNote 宿主

`packages/app/src/features/ai/chat/ChatPanel.svelte` 用现有 `prefs`，键为 `ai.chat.toolbar`：启动时读取，有变化就保存。Web 和桌面各自的 prefs 实现负责落盘，不新增后端接口。

## 4. 验收

- Aether 单元测试：
  - 默认工具栏顺序。
  - 关闭某个工具后它从工具栏消失、出现在“+”面板，并回调新数组。
  - 键盘移动顺序。
  - 恢复默认。
- AutoNote `pnpm run ci` 和 Aether `pnpm run ci` 都通过。
- 真实环境：
  - Web 浏览器里打开“自定义工具栏”，开启上传附件、移动顺序，刷新后保持。
  - 桌面安装包里同样操作，重启后保持。
