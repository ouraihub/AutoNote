import type { MessageKey } from './en-US'
export const ZH_CN_MESSAGES_6 = {
  'seed.welcome_note':
    '---\ntitle: 欢迎使用 AutoNote\ntags: [入门, AutoNote]\nal' +
    'iases:\n  - 使用指南\n---\n\n# 欢迎使用 AutoNote\n\n> [!TIP] 先' +
    '知道这五件事\n> - 这是你的私有 Markdown 笔记本；正文始终是普通文本。\n> - 内容' +
    '会自动保存，断网也能继续写，重新联网后自动补传。\n> - 新建、移动、整理和删除等常用操作会先在' +
    '本地立即生效；保存失败时安全回滚。\n> - 笔记顶部标题可以独立编辑，不必与正文第一行相同。\n>' +
    ' - MCP 完全可选，并且必须经过账号授权才能读取笔记。\n\n左侧管理笔记，正文支持即时渲染、分' +
    '栏和阅读三种方式：即时渲染中点击内容即可编辑，分栏在电脑上左右排列、手机上上下排列，阅读模式专注' +
    '浏览正文。没有专有文档格式，备份里的 `.md` 文件可以被任何文本编辑器打开。\n\n## 现在就' +
    '试试\n\n- [ ] 点击这个复选框，确认勾选状态会保存\n  - [ ] 子任务也能精确勾选，不会' +
    '改错上一行\n- [ ] 选中文字，按 `Ctrl + B` 加粗\n- [ ] 按 `Ctrl +' +
    ' K` 打开命令面板\n- [ ] 写一个 `#标签`，或点击 [[我的第一篇笔记]] 创建双链笔' +
    '记\n- [ ] 点击笔记顶部标题，把它改成与正文不同的名称\n- [ ] 新建一个子文件夹，再把它' +
    '拖到其他文件夹或同级位置\n- [ ] 按住 Alt 点击另一篇笔记，或选择**在侧边打开**，同' +
    '时处理两篇笔记\n- [ ] 在 **设置 → 关于** 把 AutoNote 安装成可离线启动的' +
    ' PWA\n- [ ] 打开 **设置 → MCP** 查看私有 AI 接入方式和权限\n- [ ]' +
    ' 在 **设置 → 备份** 添加一个备份目标\n- [ ] 给一篇笔记创建带口令的分享\n\n> [' +
    '!NOTE] 添加备份\n> 打开 **设置 → 备份**，添加 WebDAV 或 S3 目标，测' +
    '试连接后执行一次 **立即备份**。\n\n> [!NOTE] 创建安全分享\n> 打开任意笔记右上角' +
    '的 **分享**，设置访问口令和有效期。受保护分享中的附件也只有通过口令验证后才能访问。\n\n##' +
    ' 常用 Windows 快捷键\n\n| 快捷键 | 作用 |\n| --- | --- |\n| `C' +
    'trl + K` | 打开命令面板 |\n| `Ctrl + P` | 快速打开笔记 |\n| `C' +
    'trl + N` | 新建笔记 |\n| `Ctrl + Shift + F` | 全文搜索 |\n' +
    '| `Ctrl + ,` | 打开设置 |\n| `Ctrl + \\` | 切换编辑、分栏和预览 ' +
    '|\n| `Ctrl + S` | 立即保存；平时会自动保存 |\n| `Ctrl + B / I ' +
    '/ E` | 粗体、斜体、行内代码 |\n| `Ctrl + 1…6` | 设置一至六级标题 |\n' +
    '| `Shift + ?` | 查看完整快捷键 |\n\n## 为什么适合长期使用\n\n:::: ta' +
    'bs\n::: tab-item 写作\n独立标题、源码编辑、实时预览、双向滚动、专注模式、打字机模' +
    '式、大纲与版本历史。\n:::\n\n::: tab-item 组织\n最多 12 层且可拖拽排序的文件' +
    '夹、正文 `#标签`、`[[双链]]`、反向链接、关系图谱和中文全文搜索。桌面端可以在侧边再开一' +
    '篇笔记，每个窗格独立选择编辑、分栏或预览；删除文件夹时会保留并提升子文件夹，直属笔记移到上一级。' +
    '\n:::\n\n::: tab-item 搜索与 AI\n命令面板、关键词搜索，以及可选的 Worke' +
    'rs AI 语义/混合搜索。每个账号使用独立索引；AI 不可用时自动回退到关键词结果。\n:::\n' +
    '\n::: tab-item 安全与备份\n自托管、可安装 PWA、离线可写、多设备同步和冲突副本；' +
    '可同时备份到多个 WebDAV 或 S3 目标，并导出可读 Markdown、附件与完整结构化数' +
    '据。\n:::\n::::\n\n## 私有 MCP（可选）\n\n在 **设置 → MCP** 中，站长可' +
    '以启用远程 MCP 服务，每个账号再决定是否允许写入或移入回收站：\n\n- Codex、Claud' +
    'e Code 等完整 MCP 客户端通过带 PKCE 的 OAuth 2.1 授权；可以随时撤销' +
    '单个或全部客户端。\n- 脚本或不支持 OAuth 的精简客户端可以使用 `ink_...` AP' +
    'I Key。Key 只显示一次，服务端只保存哈希，也可以随时撤销。\n- MCP 可以搜索、分段读' +
    '取、查看大纲/文件夹/标签/链接，并在明确授权后安全创建、编辑、整理、移入回收站或恢复笔记；永久' +
    '删除始终不可用。\n- 配置 Workers AI 后可以建立按账号隔离的语义索引，并把语义结果与' +
    '关键词结果合并。索引可重建或清空，正文变化会在后台更新。\n\n> [!WARNING] 连接外部 ' +
    'AI 前先确认隐私政策\n> AutoNote 会隔离账号并校验权限，但已授权客户端实际读取到的内' +
    '容，之后仍由该客户端处理。\n\n## Markdown 速查\n\n每个示例标题下面，左侧是**实际效' +
    '果**，右侧是可以直接复制的**对应源码**。\n\n### 行内样式\n\n| 实际效果 | 对应源码' +
    ' |\n| --- | --- |\n| **粗体** | `**粗体**` |\n| *斜体* | ' +
    '`*斜体*` |\n| ~~删除线~~ | `~~删除线~~` |\n| ==高亮== | `==高' +
    '亮==` |\n| `行内代码` | `` `行内代码` `` |\n\n### 链接、图片与笔记关系' +
    '\n\n~~~~md-example title="普通链接"\n[打开示例网站](https://e' +
    'xample.com)\n~~~~\n\n~~~~md-example title="图片"\n![Au' +
    'toNote 项目 Logo](/autonote-logo.png "AutoNote 项目 ' +
    'Logo")\n~~~~\n\n~~~~md-example title="双链"\n[[我的第一篇笔记' +
    '|打开或创建笔记]] · [[欢迎使用 AutoNote#Markdown 速查|跳到本节]]\n' +
    '~~~~\n\n~~~~md-example title="块 ID 与块引用"\n这是一段可以被精确' +
    '定位的内容。 ^markdown-demo\n\n点击 [[#^markdown-demo]] 可以' +
    '跳回上面这段。\n~~~~\n\n~~~~md-example title="笔记嵌入"\n这段内容会在' +
    '下方被再次嵌入。 ^embed-demo\n\n![[#^embed-demo|嵌入结果]]\n~~~' +
    '~\n\n~~~~md-example title="脚注"\n这句话带有一条补充说明。[^markd' +
    'own-footnote]\n\n[^markdown-footnote]: 这是脚注的实际内容；点' +
    '击编号可以在正文与脚注之间跳转。\n~~~~\n\nObsidian 注释不会出现在预览中：`%% 单' +
    '行注释 %%`；多行内容可用单独的 `%%` 标记包围。\n\n### 公式与图表\n\n~~~~md-' +
    'example title="公式"\n行内公式：$E = mc^2$\n\n$$\na^2 + b^2' +
    ' = c^2\n$$\n~~~~\n\n~~~~md-example title="Mermaid 图表' +
    '"\n```mermaid\nflowchart LR\n  A[Markdown 源码] --> B' +
    '[实时预览]\n```\n~~~~\n\n### 现代块级扩展\n\n~~~~md-example titl' +
    'e="Obsidian Callout"\n> [!NOTE]- 默认折叠并使用自定义标题\n> 这' +
    '里可以放说明、任务、列表或其他 Markdown 内容。\n>\n> > [!TIP]+ 默认展开的' +
    '嵌套 Callout\n> > 嵌套 Callout 使用相同语法。\n~~~~\n\n~~~~md-e' +
    'xample title="折叠内容"\n::: details [点击展开]\n这里的内容会在展开' +
    '折叠块后显示。\n:::\n~~~~\n\n~~~~md-example title="标签页"\n:::' +
    ': tabs\n::: tab-item 第一个标签\n这是第一个标签页的内容。\n:::\n\n::: ' +
    'tab-item 第二个标签\n这是第二个标签页的内容。\n:::\n::::\n~~~~\n\n~~~~m' +
    'd-example title="带标题、行号和高亮的代码块"\n```ts title="hel' +
    "lo.ts\" line-numbers {2}\nconst name = 'AutoNote'\n" +
    'console.log(`Hello, ${name}!`)\n```\n~~~~\n\n## 保存、同' +
    '步与恢复\n\n内容会自动保存并同步到其他设备；断网时可以继续编辑，重新联网后会按顺序补传。普通操作' +
    '会先在本地立即显示，后台保存失败才回滚；过期的同步结果不会覆盖更新的本地状态。\n\n在 **设置 ' +
    '→ 关于** 可以安装 PWA。新版本会先提示再刷新，并在刷新前提交待保存的笔记；只有站长会收到' +
    '部署版本更新提醒。现有数据库升级会自动执行带版本号、可重复安全运行的迁移，但更新自托管实例前仍应' +
    '保留最新备份。\n\n在 **设置 → 备份** 中可添加多个 WebDAV/S3 目标并设置自动计' +
    '划；在 **设置 → 数据** 中可导入或导出 `.md`、`.zip` 和完整 JSON。\n\n' +
    '> [!WARNING] 备份不是同步\n> 建议至少使用两个不同服务商保存备份，并偶尔实际恢复一' +
    '次，确认它真的可用。\n\n## 最后\n\n按 `Ctrl + ,` 可以修改界面语言、主题、排版、编' +
    '辑器、同步和备份。读到这里，你已经知道使用 AutoNote 所需的一切；可以保留这篇速查，也可' +
    '以放心删除它，开始写自己的内容。 #入门\n',
  'gallery.title': 'AutoNote 控件图库',
  'gallery.development_only': '仅开发环境',
  'gallery.description': '组件使用独立状态，绝不访问笔记后端。',
  'gallery.actions': '操作与反馈',
  'gallery.show_notification': '显示通知',
  'gallery.open_dialog': '打开对话框',
  'gallery.open_drawer': '打开抽屉',
  'gallery.ask_confirmation': '请求确认',
  'gallery.disabled_action': '已禁用操作',
  'gallery.controls': '图库控件状态',
  'gallery.long_title': '长笔记标题',
  'gallery.input_help': '输入框保留可见的无障碍标签。',
  'gallery.validation': '校验状态',
  'gallery.validation_message': '校验消息示例',
  'gallery.enable_preview': '启用独立预览',
  'gallery.keyboard_help': '控件保持键盘可访问。',
  'gallery.completed_tasks': '包含已完成任务',
  'gallery.editor_layout': '编辑器布局',
  'gallery.editor_size': '编辑器字号：{size}',
  'gallery.dialog_title': '图库对话框',
  'gallery.dialog_description': '按 Escape 关闭此覆盖层并把焦点还给触发器。',
  'gallery.close_dialog': '关闭对话框',
  'gallery.drawer_title': '图库抽屉',
  'gallery.drawer_description': '移动端覆盖层预览',
  'gallery.close_drawer': '关闭抽屉',
  'gallery.feedback': '图库通知',
  'gallery.confirmation_title': '确认',
  'gallery.confirmation_body': '这是一个独立的图库操作。',
  'gallery.long_title_value':
    '一条很长的标题仍可正常阅读，并且不会改变共享控件的布局',
  'gallery.validation_value': '无效的图库状态',
  'gallery.live': '实时编辑',
  'gallery.split': '分栏',
  'gallery.preview': '预览',
  'workspace.preview.expand_code': '展开代码',
  'workspace.front_matter': 'Front Matter',
  'workspace.live_label': '实时编辑',
  'workspace.split_label': '分栏',
  'workspace.preview_label': '预览',
  'settings.desktop': '桌面',
} as const satisfies Partial<Record<MessageKey, string>>
