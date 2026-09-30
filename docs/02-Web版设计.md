# 02 Web 版设计（AutoNote Web）

## 1. 目标与边界

- 完整保留 AutoNote 已有的功能（见 AutoNote README 功能表），包括 MCP、分享、备份、语义搜索、PWA 和 demo 模式。
- 服务端原样移植。验收标准是把 AutoNote 的 `scripts/e2e.mjs` 原封不动地跑在 AutoNote Web 上，全部通过。
- 前端从 React 19 + zustand 改为 Svelte 5 runes，交互和视觉以 AutoNote 为基准，逐项对齐。
- 数据兼容：已部署的 AutoNote 实例可以直接换成 AutoNote Web 的代码来部署，D1、R2 和 KV 中的数据都不需要迁移。

## 2. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 构建 | Vite 8 + `@cloudflare/vite-plugin` + `@sveltejs/vite-plugin-svelte` | 沿用 AutoNote 的单一 Vite 管线，Worker 和 SPA 一起完成开发和构建 |
| 前端框架 | Svelte 5（runes），不使用 SvelteKit | 见 §3 |
| 样式 | Tailwind 4 + 原有 `tokens.css`/`prose.css`/`editor.css` | CSS 变量体系直接复用 |
| 组件 | shadcn-svelte（bits-ui）+ `@lucide/svelte` | 替代 `components/primitives|overlay|form|feedback.tsx` |
| 编辑器 | CodeMirror 6 | 扩展代码几乎不需要改 |
| Markdown | markdown-it + DOMPurify + Prism + KaTeX + Mermaid | `lib/markdown/*` 直接复用 |
| 本地存储 | idb-keyval | `lib/db.ts` 直接复用 |
| 服务端 | Hono 4.12 + D1 + R2/KV + DO + Workers AI + workers-oauth-provider | `src/worker` 原样复制 |

## 3. 为什么 Web 版不使用 SvelteKit

AutoNote 由 Worker 自己处理全部入口：`OAuthProvider` → Hono → `ASSETS.fetch` 兜底，同时导出 `SyncHub` 和 `CredentialVault` 两个 DO 以及 `scheduled` 定时任务。`adapter-cloudflare` 会让 SvelteKit 接管 Worker 入口，和上面这套结构冲突。`adapter-static` 再叠加 cloudflare 插件，开发时要跑两套 dev server，`[INFERENCE]` 两者能否兼容还没有验证。

前端只有两条路由（`/s/:slug` 和 `/n/:id`），用纯 Svelte 加一个几十行的 history 路由就足够了。代价是缺少 `$lib` 这类约定，用 Vite alias 补上 `$lib` 和 `@shared` 即可。

桌面版用 SvelteKit（与 AutoBee 一致），两边的 `.svelte` 组件可以互相拷贝，不受这个差异影响。

## 4. 目录结构

```text
AutoNote/                  # monorepo 根：pnpm-workspace.yaml、.github/workflows、docs
├── packages/shared/src/   # AutoNote src/shared（去掉 APP_VERSION 和更新源），通过 @shared/* 引用
└── web/
    ├── src/
    │   ├── release.ts         # APP_VERSION（读 web/package.json）和 GitHub 更新检查源
    │   ├── worker/            # AutoNote src/worker 原样复制
    │   └── client/
    │       ├── main.ts        # 取代 main.tsx
    │       ├── App.svelte
    │       ├── router.svelte.ts
    │       ├── lib/           # 与框架无关的部分原样复制：api/db/markdown/fuzzy/time/hotkeys…
    │       ├── state/         # 取代 store/*：*.svelte.ts 类
    │       ├── editor/        # CM6 扩展原样复制，CodeEditor.svelte 重写
    │       ├── components/ui/ # shadcn-svelte
    │       ├── components/    # Modal/Menu/Drawer/Toaster 等业务壳
    │       ├── features/      # 与 AutoNote 一一对应的 .svelte
    │       ├── demo/          # 假后端原样复制
    │       └── styles/        # 原样复制
    ├── scripts/               # e2e.mjs 原样复制；i18n/comments 检查改写
    └── wrangler*.toml  vite.config.ts  pwa.config.ts  svelte.config.js
```

## 5. 状态层设计

`store/notes.ts` 有 2875 行，一次性照搬过来风险最大。做法是先把它拆成纯逻辑模块，再在外面包一层 runes：

| 新模块 | 来源 | 内容 | 是否依赖 Svelte |
| --- | --- | --- | --- |
| `lib/notes/outbox.ts` | notes.ts outbox 部分 + db.ts | 预写日志、回放、租约锁、按 rev 做 CAS 的 rebase，409/404 恢复 | 否 |
| `lib/notes/merge.ts` | notes.ts applySync | 把 SyncResponse 合并进内存索引 | 否 |
| `lib/notes/mutations.ts` | notes.ts 各 action | 乐观补丁、快照和回滚 | 否 |
| `state/notes.svelte.ts` | notes.ts 的 state 和派生 hooks | `$state` 实体表 + `$derived` 视图，调用上面三个模块 | 是 |
| `state/ui.svelte.ts` | ui.ts | 布局、面板、主题、toast，持久化到 localStorage | 是 |
| `state/session.svelte.ts` | session.ts | 登录态、设置的防抖保存 | 是 |
| `lib/sync-engine.ts` | lib/sync.ts 的 `SyncEngine` class | 选主、WS、轮询、退避 | 否 |

规则：

1. 纯模块通过构造参数拿到 `api`、`db` 和时钟，这样可以直接用 vitest 测试，不需要 jsdom。
2. `editor/live-preview.ts` 和 `markdown/embeds.ts` 原来直接调用 zustand 的 `getState`，改成接收一个 `resolveNote(id)` 回调。
3. 大列表用 `$state.raw` 保存，更新时整体替换，避免对上千条笔记做深层代理。`[INFERENCE]` 这一点需要在 5k 条笔记的数据集上压测确认。

## 6. React → Svelte 映射

| React 做法 | Svelte 5 做法 |
| --- | --- |
| `useState`/`useReducer` | `$state` |
| `useMemo`/selector | `$derived` / `$derived.by` |
| `useEffect` | `$effect`（仅用于 DOM 或外部订阅） |
| zustand `create` + hook | `*.svelte.ts` 导出的 class 单例 |
| `useSyncExternalStore`（i18n） | `locale` 用 `$state`，`t()` 在模板中读取它，从而自动建立依赖 |
| `createPortal`（Drawer/Modal） | bits-ui Portal |
| `confirm()` 命令式队列 | 保留命令式 API，由 `ConfirmHost.svelte` 渲染 |
| ErrorBoundary class | `<svelte:boundary>` |
| `React.lazy` | `{#await import(...)}` 或动态 `import()` 加组件变量 |

## 7. 质量门

| 检查 | 处理方式 |
| --- | --- |
| `typecheck` | 用 `svelte-check` 加 `tsc -b` 检查 worker |
| `i18n:check` | 规则不变。解析器从 TS AST 换成 `svelte/compiler` 的 `parse`，用来检查模板文本和 `label/title/placeholder` 属性 |
| `comments:check` | 规则不变，文件扫描范围加上 `.svelte`（包括 `<!-- -->` 和 `<script>` 里的注释） |
| `test:unit` | vitest。纯模块在 node 环境跑，组件用 `@testing-library/svelte` |
| `test:e2e` | 直接使用 AutoNote 的原文件，它就是 API 回归测试 |
| `lint` | 新增 eslint + eslint-plugin-svelte（AutoBee 同款配置） |

## 8. 部署

命令和 AutoNote 一致：`npm run deploy` / `deploy:kv` / `deploy:demo`，改为 `pnpm` 执行。`wrangler.toml` 中的 D1、R2、DO、AI 绑定名称保持不变。Worker 的 `name` 改为 `autonote`，这会影响 `*.workers.dev` 子域名。如果是给已有实例升级，需要在 wrangler 配置里沿用原来的 name 和 `database_id`。

## 9. 需要更新的品牌字段

已改的：界面文案、Logo（`public/` 下的图标都由 `autonote.png` 生成）、`manifest.webmanifest`、package 名、`APP_NAME`、worker 和 locale 中用户可见的 "AutoNote" 字样，以及 e2e 中对站点名和欢迎笔记标题的断言。还没改的：`shared/constants.ts` 里的 `GITHUB_REPOSITORY_URL` 和 `GITHUB_PACKAGE_URL`，它们仍然指向 shuaiplus/autonote，要等 AutoNote 有了自己的仓库地址才能改，否则版本更新提醒会拿上游的版本号来比较。

不能改的：cookie 名、`X-AutoNote-Client`、`X-AutoNote-Origin` 请求头、备份格式标识和 IndexedDB 库名。改了这些，桌面版就连不上已有实例，现有用户的离线队列也会丢失。
