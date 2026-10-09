# 11 详细设计：Web 宿主

> 状态：全阶段设计基线；W4–W6 本轮代码交付见 §14，真实运行判据仍待统一验收，未据代码落地宣称通过。任务组 W1–W6，实施任务见 §13。
> 契约以 `02-概要设计.md` 为准，写法以 `04-工程规范.md` 为准。端口的完整 TS 签名见 `10-详细设计-共享应用层.md` §2，本文只引用，不重新定义。
> 源码对照：参考项目 `src/client/lib/{api,db,sync}.ts`、`store/{notes,session,pwa}.ts`、分享页、demo 与 PWA 配置；本轮另核对 AutoPad 当前 worker 的 `app.ts`、`routes/{sync,mcp-settings}.ts`。本文保留可用的源码定位，不以旧行号替代契约；依赖兼容性和运行判据在实施时验证。

## 1. 范围与结论

- `web/src/client` 是组合根：装配 `HttpBackend`、`SyncEngine`、`ConsoleRingLogger`、`WebPrefsStore`，然后调用 `@app/root` 的 `mountApp`。它不写业务界面，只有两处例外：公开分享页 `/s/:slug`（匿名访问，不经过端口，02 §2 表格已划给 Web 宿主）和「设置 → 关于」里的 PWA 面板（经 `HostExtensions.aboutPanels` 注入）。
- **worker 零 API 改动**。worker 侧只调整部署配置；`/s/:slug` 由现有 `routes/share.ts` `renderShareShell` 从 ASSETS 取 index.html 注入 OG 元信息，对新的 Svelte 外壳原样可用。演示静态部署单独使用 `web/wrangler.demo.toml`。
- 离线写入保留 参考项目 `store/notes.ts` 与 `lib/db.ts` 的日志字段和恢复语义，兼容既有 IndexedDB 数据，不要求序列化字节相同。纠正旧逻辑中损坏日志静默丢弃、注销清空未上传数据等不安全路径（§3、§10、§12）。
- 同步引擎沿用 `lib/sync.ts` 的 `SyncEngine`（广播选主、WS、心跳、轮询、退避），只把"直接调 zustand"改成"注入端口 + 发 `ChangeEvent`"（§5）。
- 协议标识保持不变：`X-参考项目-Client`、`X-参考项目-Origin`、cookie 名、IndexedDB 库名 `autonote`、BroadcastChannel 名 `autonote`、outbox 回放锁名 `autonote-outbox-replay:<userId>`。

依赖的共享层任务（任务号见 `10`）：S0-1（包与别名）、S0-2（eslint/prettier）、S0-3（vitest 双环境）、S1-1（shared DTO）、S1-2（端口、错误、统一 ChangeFeed）、S1-3（平台接缝）、S1-4（行为契约）、S2-1（i18n）、S2-2（主题）、S3-1/S3-2/S3-3（基础件、覆盖层、图库）、S4-1/S4-2（Markdown）、S5-1/S5-2（编辑器）、S6-1 至 S6-5（状态）、S7-1 至 S7-5（组合根与导航）、S8-1 至 S8-3（工作区）、S9-1 至 S9-4（设置与图谱）。§13 每个任务列出自身直接依赖，不用范围或通配符充当依赖。

## 2. 目录与模块

```text
web/
├── index.html                 # #boot 首屏 + 首屏主题脚本（S2-2 提供内容）+ /src/client/main.ts
├── pwa.config.ts              # autonotePwa()：生成 sw.js（W5-2）
├── vite.config.ts             # 新增 demo 模式、@app 别名（S0-1）、wrangler 配置覆盖（W6-1）
├── wrangler.demo.toml         # W5-3
├── scripts/
│   ├── e2e.mjs                # 保留有效行为场景；删除失效细节断言，补真实回归
│   ├── check-i18n.mjs         # W1-2，扫描 .ts/.svelte
│   ├── check-comments.mjs     # W1-3，扫描 .ts/.svelte/.css/.html/.toml
│   └── deploy.mjs             # W6-1，定位 dist/<name>/wrangler.json 后执行 wrangler deploy
└── src/client/
    ├── main.ts                # 组合根（唯一装配具体实现的地方）
    ├── runtime.ts             # IS_DEMO_MODE、存储名常量
    ├── router.ts              # parseLocation / formatNotePath（纯函数）
    ├── platform/
    │   ├── prefs.ts           # WebPrefsStore implements PrefsStore
    │   ├── timers.ts          # Timers 接口 + browserTimers
    │   └── page-signals.ts    # PageSignals 接口 + browserPageSignals
    ├── log/console-ring-logger.ts
    ├── backend/
    │   ├── index.ts           # 公开入口：createWebBackend()、WebBackendDeps
    │   ├── transport.ts       # HttpTransport：请求头、超时、错误转换
    │   ├── errors.ts          # toBackendError / offlineError（纯函数）
    │   ├── tab-bus.ts         # TabBus 接口 + BroadcastTabBus + MemoryTabBus（测试）
    │   ├── ports/{session,notes,folders,tags,search,files,settings,transfer,share,backup,mcp,update}.ts
    │   └── download.ts        # 导出文件落盘（showSaveFilePicker / <a download>）
    ├── local/
    │   ├── kv-store.ts        # KvStore 接口 + IdbKvStore + MemoryKvStore
    │   ├── local-db.ts        # LocalDb：会话、shell、正文缓存、用户命名空间
    │   └── guards.ts          # isNoteSummary/isFolder/isTag/isSessionInfo（自 db.ts:434-512）
    ├── outbox/
    │   ├── types.ts           # OutboxItem、OutboxPayload
    │   ├── outbox-store.ts    # OutboxStore：入队、完成、改 rev、恢复 ID、失败计数
    │   ├── order.ts           # sortOutboxForReplay（纯函数）
    │   ├── replay-lock.ts     # ReplayLock 接口 + NavigatorReplayLock + LeaseReplayLock
    │   └── replayer.ts        # OutboxReplayer：回放循环与 200/409/404 分支
    ├── sync/
    │   ├── full-sync.ts       # 全量分页收集 + 纯函数 consolidateFullSync
    │   ├── puller.ts          # SyncPuller：分页拉取 → shell → ChangeEvent
    │   ├── leader.ts          # compareClaims 与选主状态（纯函数 + 小类）
    │   ├── socket.ts          # SocketFactory 接口 + browserSocketFactory
    │   └── engine.ts          # SyncEngine：向 Backend 持有的唯一 ChangeFeed 发事件
    ├── share/
    │   ├── SharePage.svelte   # 容器组件
    │   ├── SharePageView.svelte
    │   ├── share-page.svelte.ts   # SharePageState
    │   └── share-access.ts    # addShareAccess（纯函数）
    ├── pwa/
    │   ├── pwa.svelte.ts      # PwaState
    │   └── PwaPanel.svelte    # aboutPanels 注入
    └── demo/{backend,state,runtime}.ts   # 自 参考项目 src/client/demo 移植
```

模块规则：

- 每个子目录只通过 `index.ts` 暴露契约（04 §2.3）；`main.ts` 只 import 各子目录的 `index.ts`。
- 需要在测试中替换的边界都定义成接口，由本目录使用方定义（04 §2.1）：`KvStore`、`ReplayLock`、`TabBus`、`SocketFactory`、`Timers`、`PageSignals`、`FetchLike`。时间读取统一用 `@app/platform` 的 `Clock.now()`。
- `fetch`、`indexedDB`、`BroadcastChannel`、`WebSocket`、`navigator.locks`、`localStorage` 只允许出现在上面这些接口的浏览器实现文件里，由 eslint `no-restricted-globals` 按文件配置（W1-1 写进根 `eslint.config.js` 的 web 分区）。

```ts
// platform/timers.ts
export interface Timers {
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
  setInterval(fn: () => void, ms: number): number
  clearInterval(id: number): void
}
// platform/page-signals.ts —— 页面生命周期，SyncEngine 与 PwaState 订阅
export type PageSignal = 'visible' | 'hidden' | 'focus' | 'online' | 'offline' | 'pagehide'
export interface PageSignals {
  readonly isHidden: boolean
  readonly isOnline: boolean
  on(signal: PageSignal, listener: () => void): () => void
}
// backend/transport.ts
export type FetchLike = (request: Request) => Promise<Response>
```

## 3. Outbox 与冲突处理

本节是 02 §7 的 Web 写入规则来源。原则：**既有日志字段兼容，控制流对照 `store/notes.ts:2105-2324`**。对应用只发统一 `changes`：`{kind:'write',payload:WriteQueueEvent}` 或真实同步响应的 `{kind:'sync',payload:SyncResponse}`；不存在第二条写事件总线。

### 3.1 IndexedDB 存储键

`idb-keyval` 的 `createStore(CLIENT_DATABASE_NAME, 'kv')`（`lib/db.ts:13`），库名 `autonote`，demo 模式为 `autonote-demo`（`lib/runtime.ts:14`）。键表照抄 `db.ts:15-25`：

| 键 | 是否按用户隔离 | 值 | 读写方 |
| --- | --- | --- | --- |
| `userId` | 否 | 当前绑定的用户 ID | `LocalDb.bindUser` |
| `session` | 否 | `SessionInfo`（`user` 非空才写） | `session.load` 成功后写，离线启动时读 |
| `notes` / `folders` / `tags` / `cursor` | 是 | shell：`NoteSummary[]`、`Folder[]`、`Tag[]`、`number` | `SyncPuller` 合并后以同一 `setMany` 事务提交；可 80 ms 合并缓存写，但不可独立提前提交 cursor（§5.2） |
| `note:<id>` | 是 | `CachedNoteContent`（`db.ts:53-60`） | `notes.get` 成功后写；入队时写 `writeId`/`pendingTitle`/`contentDirty` |
| `outbox` | 是 | `OutboxItem[]`（整个数组一个键） | `OutboxStore` |
| `outboxReplayLease` | 是 | `{ owner: string; expiresAt: number } \| null` | `LeaseReplayLock` |

- 用户隔离：实施时锁定支持 `entries/delMany` 的 `idb-keyval` 版本并验证兼容性，键写成 `user:<userId>:<key>`。首次绑定只迁移旧 `userId` 所属的无前缀键；迁移写入成功后才删除旧键。**不沿用换用户就清库的降级**：不支持所需能力就报存储错误并停止切换，原数据保留。旧用户未上传日志不转给新用户（§10）。
- 读缓存用 `guards.ts` 校验。无效可重建 shell/正文缓存可以失效后重新拉取；outbox 无效条目、未知字段必须保留原始存储，不得 `normalizeOutbox` 后覆盖掉损坏条目。报告存储失败并阻止注销及自动清理，保留原数据供恢复，不把坏日志伪装成空队列。
- `KvStore` 暴露 `get/getMany/set/setMany/update/del/delMany/entries/clear`，生产适配 `idb-keyval`，内存实现仅用于隔离行为测试。缓存读失败允许返回空并记录 `local.read.failed`；outbox 读失败必须抛错，不能当空队列放行注销。所有写失败向上抛 `BackendError('internal',0,'Local persistence failed')`，底层异常只留脱敏诊断。

### 3.2 OutboxItem

```ts
// outbox/types.ts —— 字段与 db.ts:41-51 完全一致，不得增删改名
export interface OutboxItem {
  id: string               // 槽位：`patch:${CLIENT_ID}:${noteId}`（notes.ts:1932-1934）
  clientId: string         // 入队标签页的 CLIENT_ID
  writeId: string          // 每次入队新生成（同槽位覆盖时换新）
  dependsOnWriteId?: string
  noteId: string
  payload: OutboxPayload
  attempts: number
  createdAt: number        // 覆盖同槽位时保留首次的 createdAt（db.ts:262-275）
  lastError?: string
}
export interface OutboxPayload {
  rev: number              // 基线 rev
  content: string
  contentDirty: boolean    // false 表示只改标题，回放时不发 content
  title?: string
  preserveVersion?: true   // rebase 后置位
  recoveryId?: string      // 404 恢复时预先持久化的副本 ID
  readonly [key: string]: unknown   // 保留 参考项目 写入的未知字段，原样回写
}
```

`OutboxStore`（构造注入 `KvStore`、`() => string | null` 取当前用户键前缀）方法与 `localDb` 一一对应，签名不变：`list()`、`enqueue(item)`、`complete(id, writeId)`、`updateRevision(id, writeId, rev, preserveVersion)`、`setRecoveryId(id, writeId, recoveryId)`、`advanceDependents(noteId, sourceWriteId, expectedRev, nextRev)`、`markFailure(id, writeId, message)`（`db.ts:260-348`）。每个方法都是对 `outbox` 键的一次 `update()`，保证单键原子。

### 3.3 入队（`notes.patch`）

只有 body 仅含 `rev` + `content` / `title` / `preserveVersion` 的 patch 走 outbox（与 `10` 约定一致，对照 `stageNoteTextWrite` `notes.ts:1296-1349`）；其余写方法直发，离线时抛 `BackendError('offline')`。

`HttpBackend` 内部每标签页维护 `#pending: Map<noteId, PendingWrite>`。同槽位更新需要 writeId，旧请求完成不能删掉新条目：

```ts
interface PendingWrite {
  readonly queueId: string
  readonly writeId: string
  readonly dependsOnWriteId: string | undefined
  readonly rev: number
  readonly content: string
  readonly contentDirty: boolean
  readonly title: string | undefined
  readonly durable: Promise<void> // 只表示入队落盘，不等待网络
}
```

步骤：

1. `writeId = options.writeId`，由 app 为此次编辑生成；宿主原样贯穿返回值和 write 事件。`queueId = pending?.queueId ?? outboxId(noteId)`，独立于 mutation 身份。
2. `contentDirty = pending?.contentDirty === true || body.content !== undefined`。`content` 取 `body.content ?? pending?.content ?? 正文缓存 ?? ''`；标题单独更新且无缓存时允许 `contentDirty:false`、`content:''`，回放不发 content，不把空串覆盖到服务器正文。
3. `dependsOnWriteId = pending?.dependsOnWriteId ?? inherited(noteId)`：outbox 里若已有**其他 clientId** 对同一笔记、同一基线 rev 的条目，记下它的 `writeId`（参考项目 `inheritedOutboxWrites`）。这样回放时先发它，它成功后 `advanceDependents` 把本条的 rev 推进到它保存后的 rev，避免自己和自己冲突。
4. **立即** `await outbox.enqueue(item)`，不等待编辑器自动保存防抖；再更新带 writeId 的正文缓存。outbox 是权威日志，缓存失败不撤销成功日志；下一次读由日志恢复。入队期间后续输入继续产生新 writeId，IDB 更新必须保持每标签页的输入顺序。
5. 入队提交即返回 `{ queued:true, noteId, rev:item.payload.rev, writeId }`；在线也不等网络。通过 `changes` 发 pending 数，并以 `max(100, settings.editor.autoSaveDelay)` 防抖网络回放。立即 flush、online、同步回放可以提前发送已持久日志，不改变落盘时机。异步确认/恢复/失败只走 `changes.kind='write'`。
   - 入队失败时不得返回 queued 或标记已本地保存；可以在线直接 PATCH 成功后返回 `{queued:false,writeId,note}`。若请求也失败，抛出结构化错误，app 保留编辑缓冲并展示未保存，不回滚随后输入。离线且不能落盘必须明确失败。
   - 文本之外的在线 PATCH 成功返回 `{queued:false,writeId,note}`；其 409 交给 app，绝不借用 outbox rebase 静默覆盖。
6. `rev` 前推：同一笔记上一条写入保存成功、而 `#pending` 已被更新的写入覆盖时，若新写入的 rev 等于上一条提交的 rev，就把它改成保存后的 rev（`settleSavedPatch` + `advanceDirtyRevision`，`notes.ts:1626-1651,1851-1861`），并 `outbox.updateRevision` 落盘。

### 3.4 回放顺序（`OutboxReplayer`）

```ts
export interface OutboxReplayerDeps {
  outbox: OutboxStore; lock: ReplayLock; transport: HttpTransport; bus: TabBus
  pending: PendingWrites; content: LocalDb; clock: Clock; logger: Logger
  emitChange(event: ChangeEvent): void // write 也包装后走此唯一出口
  requestPull(options: { force: boolean }): void
  createRecoveryCopy(input: { id: string; title: string; content: string }): Promise<Note>
}
export class OutboxReplayer {
  constructor(deps: OutboxReplayerDeps)
  replay(): Promise<void>          // 单飞：进行中再次调用返回同一个 Promise
  pendingCount(): Promise<number>  // outbox 与 #pending 的 noteId 并集大小（notes.ts:2325-2330）
}
```

触发时机：在线入队后的网络防抖到期；每次 pull 完成后；`online`；显式 `notes.flush(noteId?,options?)` / `syncNow`。flush 绕过发送防抖，等待本地提交并尝试回放，返回 `{pending,failed}`，离线日志保留计入 pending。`pagehide` 仅尽力触发，不承担最终落盘保证；浏览器不保证等待异步 unload。

1. **跨标签页互斥**：`ReplayLock.run(owner, task)`。`NavigatorReplayLock` 用 `navigator.locks.request('autonote-outbox-replay:<userId>')`；不支持时 `LeaseReplayLock` 在 `outboxReplayLease` 上做 90 s 租约、20 s 心跳、最多等 30 s（`db.ts:350-406`）。没拿到锁就只刷新 pending 数（`notes.ts:2105-2119`）。
   - 租约取得/续期使用单键原子update并比较owner，每次发请求前检查有效持有；失去租约立即停止后续发送。已在途请求不能撤回已提交服务器写，恢复后仍依靠rev/CAS和内容相等确认避免重复覆盖，不宣称浏览器暂停下的严格恰好一次。
2. **轮次**：最多 20 轮（`notes.ts:2123`）。每轮先把 `#pending` 中尚未落盘的写入补写进 outbox（`loadReplayOutbox`，`notes.ts:1981-2002`，最多补 4 次），再读 outbox，丢掉被本标签页更新写入覆盖的旧槽位，用 `attempted` 集合（键 `id\0writeId\0rev`，`notes.ts:1961-1963`）排除本次已试过的条目。
3. **排序**：`sortOutboxForReplay`（`notes.ts:2003-2030`）：先按 `createdAt`、再按 `id` 稳定排序；然后按 `dependsOnWriteId` 做深度优先拓扑，依赖先发；遇到环直接跳过环边，不抛错。这是纯函数，放 `order.ts`，单测覆盖。
4. **每条的前置**：
   - 同 noteId 有未完成的 `notes.create` 请求时先等它（`pendingNoteCreates`，`notes.ts:2131-2139`）；
   - 本标签页已经处理过恢复、但当时 `complete` 没写成功的条目，重试 `complete` 后跳过（`retryRecoveredOutbox`，`notes.ts:2062-2075`）；
   - 条目属于本标签页、而 `#pending` 已换成同槽位更新的 `writeId`：等新写入落盘后跳过，由新条目承担发送；
   - 只有 pending.writeId 等于持久条目 writeId 时才读取对应内存 payload；发送前冻结 `{id,writeId,rev,content,title}` 快照。若出现更新 writeId，先等新入队并重新读，不得给旧writeId偷换新正文；其他页推进基线时先持久化再发送。
   - payload 不合法（content 非字符串或 rev < 1）：`markFailure('invalid offline journal payload')` 后继续。
5. **发送**：`PATCH /api/notes/:id`，body 为 `{ rev, content?（仅 contentDirty）, title?, preserveVersion? }`（`notes.ts:2167-2172`）。

### 3.5 回放结果分支

| 响应 | 处理 | 事件 | 对照 |
| --- | --- | --- | --- |
| 200 | 推进本标签页后续写入的 rev、缓存已确认正文；其他标签页结果只匹配对应 writeId。`advanceDependents` 并广播 `outbox-base-advanced`；`complete(id,writeId)`；广播 `outbox-result{outcome:'saved'}`。返回值带的 rev 不当作 sync cursor；调度真实 pull | `write` 包装 `settled{noteId,writeId,note}`；pull 后 `sync` | `notes.ts:2166-2199` |
| 409 且**已确认** | 见下，视为该条已提交；推进基线并条件删除 | 同 200 | `notes.ts:2201-2240` |
| 409 未确认 | 持久化 `updateRevision(queueId,writeId,server.rev,true)` 后更新内存基线；下一轮带 `preserveVersion:true` 重发。**本地离线编辑胜出，服务端正文强制进入版本历史**。rebase 落盘失败停止该条，不用未持久的新基线继续发 | `write` 状态保留 pending；日志 `outbox.replay.rebased`；调度真实 pull | `notes.ts:1862-1900,2241-2248`；worker `notes.ts:447-463` |
| 409 无 `details.server` | `markFailure`，保留日志，等待显式重试 | `write` 包装 `failed{noteId,writeId,code:'conflict',retained:true}` | `notes.ts:2246-2247` |
| 404 | 恢复副本，见 §3.6 | `write` 包装 `recovered{noteId,writeId,copy,reason:'deleted'}` | `notes.ts:2250-2302` |
| `offline` / `request_timeout` | 停止回放，所有未完成日志保留；只有网络不可达发送 offline connectivity，超时不冒充断网 | `write` 包装 pending 数；失败含原 code、retained:true | `notes.ts:2303-2307` 的结构化适配 |
| 401 | 暂停整个用户回放；由 `write.failed` 的 `unauthenticated` 及会话重新 load 流程退回登录。禁止清库或误报 offline；原账号重新认证后恢复 | `write` 包装 `failed{noteId,writeId,code:'unauthenticated',retained:true}`；`settings` 触发会话刷新 | 本设计的安全适配 |
| 其他（400/403/413/429/5xx） | `markFailure`、`attempts+1`、保留日志。400/403/413 停止自动重试该条至用户修正；429 遵守 retryAfter；5xx 下次网络恢复/显式同步再试，不在循环热重试 | `write` 包装 `failed{noteId,writeId,code,retained:true}`；持续失败在最终处理层汇总 error | 对照 `notes.ts:2312-2316` |

“已确认”的判定：服务端正文等于**本次已发送条目**内容（或本条 `contentDirty=false`），且标题相同（或本条不改标题），可视为本次发送已成功。不得用尚未发送的新 writeId 内容相等来直接结算新写入；旧响应只推进匹配的基线，保留新条目。成功与 `complete` 都必须比较 writeId，依赖推进按原 expectedRev 匹配，避免迟到响应撤销下一次输入。

### 3.6 404 恢复副本

对照 `notes.ts:2250-2302` 保留“恢复ID先落盘”顺序；以 writeId 冻结恢复输入，不能用已有副本的幂等返回去结算尚未提交的新正文：

1. 取本条已持久的内容和标题，缺省标题可读同笔记缓存。读取期间发现更新writeId则先等新日志，重启该条流程；每个恢复请求固定其输入快照。
2. `recoveryId = payload.recoveryId ?? newLocalEntityId()`；如果是新生成的，**先** `setRecoveryId(id, writeId, recoveryId)` 落盘，失败则 `markFailure('could not persist the recovery note id')` 并跳过。
3. `POST /api/notes` 带 `{ id: recoveryId, title, content }`。worker 对"同用户、同 ID 已存在"直接返回现有笔记（`routes/notes.ts:281-287` 的 `existing` 分支），所以重启后重复执行是幂等的。
   - 响应可能来自先前同ID创建：比较实际返回的copy与本次恢复快照，文本不一致时以copy.rev发送保留版本PATCH到副本，确认后才complete原条目；失败仍保留原日志。该过程只处理已冻结writeId，新输入保留独立日志并沿已持久recoveryId继续恢复，绝不删除新槽位。
4. `settleRecoveredOutbox`：先把结果记进内存 LRU（上限 200，`notes.ts:2046-2061`），再 `complete`；成功后给入队标签页广播 `outbox-result{outcome:'recovered',recoveryReason:'deleted',copyId}`。
5. 若仍是本标签页最新 writeId，清除该 pending；旧 note 的未关联缓存可失效。其他新写入不能删除。删除与副本摘要通过真实 pull 返回的 `SyncResponse` 合并；有 `details.deletionCursor` 时仍不伪造 full/游标，缺失时强制全量拉取。
6. 经 `changes` 发 `{kind:'write',payload:{kind:'recovered',noteId,writeId,copy,reason:'deleted'}}`；app 由完整 `copy:Note` 展示恢复结果并提供跳转，不用不存在的 `notes` 事件。toast 与“打开副本”由共享状态层负责。

旧 `BroadcastPayload` 可以携带 `recoveryReason:'conflict'`，但当前端口只接受 `reason:'deleted'`。收到旧冲突恢复广播时不强转成新事件：拉取 copyId 对应笔记并走真实 sync 刷新、保留旧日志直至确认；本版 409 的生产路径只有保留版本 rebase，不新增共享联合分支。

### 3.7 多标签页协作（`TabBus`）

```ts
export interface TabBus {
  post(message: TabMessage): void               // 自动附带 userId
  subscribe(listener: (message: TabMessage) => void): () => void  // 过滤掉 userId 不同的消息
  close(): void
}
export type TabMessage = BroadcastPayload       // 形状照抄 db.ts:514-543，一个字段都不改
```

`BroadcastTabBus` 使用 `new BroadcastChannel('autonote')`（`db.ts:545-577`），`MemoryTabBus` 在同一进程内连接多个 `HttpBackend` 实例，用来测多标签页。消息消费方：

| 消息 | 消费者 | 动作 |
| --- | --- | --- |
| `outbox-result`（`targetClientId === CLIENT_ID`） | `HttpBackend` | 匹配 writeId 后发统一 `write` 事件，过期结果只推进有效基线，不覆盖当前缓冲（`notes.ts:2348-2429`） |
| `outbox-base-advanced`（非本标签页） | `HttpBackend` | 推进 `#pending` 与本地依赖条目的 rev（`notes.ts:2336-2347`） |
| `local-write` / `pulled` / `claim-leader` / `settings-changed` / `profile-changed` / `site-changed` | `SyncEngine` | 见 §5 |

发送 `local-write` 的规则不变：非 GET、路径匹配 `^/api/(notes|folders|tags|import)`、响应成功（`api.ts:121-159,263-265`）；`settings.save`、`account.updateProfile`、`account.updateRegistration` 成功后分别发 `settings-changed`、`profile-changed`、`site-changed`（`api.ts:323-334,441-444`）。

## 4. HttpBackend

### 4.1 装配入口

```ts
// backend/index.ts
export interface WebBackendDeps {
  fetch: FetchLike            // 生产：globalThis.fetch；demo：createDemoBackend().fetch
  kv: KvStore                 // 生产：IdbKvStore('autonote' | 'autonote-demo')
  bus: TabBus
  lock: ReplayLock
  sockets: SocketFactory | null   // demo 传 null，不连 WS
  timers: Timers
  page: PageSignals
  clock: Clock
  logger: Logger
  getLocale(): string         // 来自 @app/i18n 的 getLocale，写 Accept-Language
  clientId: string            // CLIENT_ID，main.ts 生成一次（api.ts:44-47）
}
export type WebBackend = Backend // dispose() 已属于共享端口，不另扩一套生命周期
export function createWebBackend(deps: WebBackendDeps): WebBackend
```

`createWebBackend` 内部按顺序构造 `HttpTransport` → `LocalDb` → `OutboxStore` → `OutboxReplayer` → `SyncPuller` → `SyncEngine` → 各端口对象，端口对象都是小类（`class HttpNotesPort implements NotesPort`），构造参数只收自己需要的依赖。端口签名全部以 `10` §2 为准，本文不重复。

`capabilities`（常量）：`accounts: true, totp: true, share: true, remoteBackup: true, semanticSearch: true, mcp: 'remote', realtime: true, remoteSync: false, updateCheck: true`。`realtime: true` 只表示"这个后端支持实时通道"，是否真的连 WS 由 `SiteInfo.realtimeEnabled && settings.sync.realtime` 决定（`sync.ts:364-368`）；`updateCheck` 对非站长由 worker 返回 403（`routes/update.ts:11-14`），界面按 `user.role` 隐藏入口。

### 4.2 HttpTransport

```ts
export interface RequestSpec {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: `/api/${string}`
  query?: Readonly<Record<string, string | number | boolean | undefined>>
  body?: unknown                 // JSON
  form?: FormData
  signal?: AbortSignal
  timeoutMs?: number
}
export class HttpTransport {
  constructor(deps: { fetch: FetchLike; clientId: string; getLocale(): string; bus: TabBus; timers: Timers; logger: Logger })
  json<T>(spec: RequestSpec): Promise<T>
  raw(spec: RequestSpec): Promise<Response>      // 下载用，已通过状态码检查
}
```

行为逐条对照 `api.ts:79-170`：

- 请求头固定 `X-参考项目-Client: 1`（`CLIENT_HEADER`，worker `requireClientHeader` 要求所有 `/api/*` 带它）、`X-参考项目-Origin: <clientId>`、`Accept-Language: <locale>`；`credentials: 'same-origin'`。JSON body 加 `Content-Type: application/json`；`FormData` 不设 Content-Type。
- `query` 按 `toQuery` 规则拼接：丢弃 `undefined` 与空串，布尔值写成 `1`/`0`（`api.ts:390-401,510-514`）。
- 超时：`timeoutMs > 0` 时另建 `AbortController`，调用方 signal 取消时联动取消；定时器走注入的 `Timers`。默认值沿用 参考项目：`notes.create/patch`、`account.updateProfile` 30 s，`sync` 30 s，`update.check` 10 s，其余不设。
- 204 返回 `undefined`；JSON 响应按 `content-type` 判断（`application/json` 或 `+json`，`api.ts:172-175`）。
- 成功的非 GET 写请求命中 `shouldNotifyOtherTabs` 时广播 `local-write`（§3.7）。

### 4.3 错误转换（`backend/errors.ts`）

边界上只抛 `BackendError`（04 §4.2）。`toBackendError` 是纯函数，单测覆盖每一行：

| 原始情况 | `code` | `status` | `details` | 对照 |
| --- | --- | --- | --- | --- |
| `fetch` 抛出（`TypeError: Failed to fetch` 等） | `offline` | 0 | — | `api.ts:165` |
| 本端超时触发的中止 | `request_timeout` | 0 | 不宣告网络离线，不新增 worker code（§12） | `api.ts:163` |
| 调用方 `signal` 中止 | `cancelled` | 0 | 端口只抛 BackendError；取消不危险 toast（§12） | `api.ts:164` 的边界适配 |
| 非 2xx 且 body 为 `{error:{code,message,details?}}`，code属于ErrorCode | 该code | 响应状态 | 只保留校验后的server/deletionCursor/retryAfter/字段路径 | `api.ts:141-151`的安全适配 |
| 同上但 `code` 不在 `ErrorCode` 里 | `internal` | 响应状态 | 不透传未知 details；最终处理层记录安全的 unmapped code | `backend.error.unmapped`（warn） |
| 非 2xx 且 body 不是 JSON（例如 CF 的 HTML 502） | 按状态映射：400→`bad_request`、401→`unauthenticated`、403→`forbidden`、404→`not_found`、409→`conflict`、413→`payload_too_large`、429→`too_many_attempts`、503→`storage_unavailable`、其余→`internal` | 响应状态 | — | — |
| 2xx 但 JSON 解析失败 | `invalid_response` | 502 | 不保留响应原文，不触发离线逻辑 | `api.ts:153-155` |

- `message` 保留服务端英文原文，不在宿主翻译；用户可见文案由 app 的 `translateError(error)` 按 `code` 生成（`api.error.<code>`），`translateServiceMessage` 只作文案映射（04 §4.1 例外）。
- 账号相关 code（`invalid_credentials`、`weak_password`、`two_factor_*`、`registration_closed`、`username_taken`、`wrong_password`、`invalid_username`、`invalid_avatar`）只会从 `session.account.*` 返回；它们属于 `ErrorCode` 的账号子集（02 §5 末段），原样透传。
- `429` 的 `details.retryAfter`、`404` 笔记的 `details.deletionCursor`、`409` 笔记的 `details.server` 原样保留，outbox 依赖后两者。
- 公开分享页的 `password_required` / `password_invalid`（`routes/share.ts:177,208`）不经过端口，由 `SharePageState` 自己按 HTTP 401 处理（§6.2），不进 `ErrorCode`。

### 4.4 端口 → 路由映射

路由以当前 worker 挂载点及 参考项目 `lib/api.ts` 调用形状为依据。列表解包必须遵守 `10` §2：`notes.list` 保留 `ListNotesResponse`，`files.list` 保留 `{files,nextCursor}`，不能为了方便丢掉游标；只有无分页的 folders/tags 等数组才可解包。

| 端口方法 | 请求 | worker 位置 | 参考项目 | 说明 |
| --- | --- | --- | --- | --- |
| `session.load` | `GET /api/auth/session` | `auth.ts:96` | `api.session` | 成功且 `user` 非空时 `LocalDb.saveSession`；`offline` 时读缓存会话，缓存的 `userId` 必须与 `userId` 键一致才用（`session.ts:54-77`，`db.ts:152-163`） |
| `session.logout` | `POST /api/auth/logout` | `auth.ts:361` | `api.logout` | 先本地持久、尝试回放并检查所有用户 outbox/未保存设置；仍有待上传即拒绝注销，不发 POST，不清库（§10.2） |
| `account.register` | `POST /api/auth/register` `{username,password,locale}` | `auth.ts:126` | `api.auth.register` | |
| `account.login` | `POST /api/auth/login` | `auth.ts:182` | `api.auth.login` | 返回 `PasswordLoginResult`（可能要求二步） |
| `account.completeTotpLogin` | `POST /api/auth/totp/login` `{challengeToken,code}` | `totp.ts:20` | `api.auth.totp.completeLogin` | |
| `account.totp.status/startSetup/confirmSetup/cancelSetup/regenerateRecoveryCodes/disable` | `GET /status`、`POST /setup`、`POST /setup/confirm`、`DELETE /setup`、`POST /recovery-codes`、`DELETE /`（前缀 `/api/auth/totp`） | `totp.ts:37-86` | `api.auth.totp.*` | `DELETE` 带 JSON body |
| `account.setPassword` | `POST /api/auth/password` | `auth.ts:336` | `api.auth.setPassword` | |
| `account.updateProfile` | `PUT /api/auth/profile`（30 s） | `auth.ts:244` | `api.auth.updateProfile` | 成功后广播 `profile-changed` |
| `account.updateRegistration` | `PUT /api/settings/registration` | `settings.ts:17` | `api.auth.updateRegistration` | 成功后广播 `site-changed` |
| `notes.snapshot` | 无网络请求（离线）或 `GET /api/sync?since=<cursor>` | `sync.ts:24` | `bootstrap` + `pull` | 见 §4.5 |
| `notes.list` | `GET /api/notes?…` | `notes.ts:58` | `api.notes.list` | |
| `notes.get` | `GET /api/notes/:id` | `notes.ts:252` | `api.notes.get` | 见 §4.5 |
| `notes.create` | `POST /api/notes`（30 s） | `notes.ts:257` | `api.notes.create` | 客户端生成 ID；同 ID 重发幂等 |
| `notes.patch` | 文本：outbox（§3.3）；其余：`PATCH /api/notes/:id`（30 s） | `notes.ts:343` | `api.notes.patch` | |
| `notes.remove` / `restore` / `purge` | `DELETE /:id`、`POST /:id/restore`、`DELETE /:id/purge` | `notes.ts:569,627,669` | 同名 | 执行前先 `flush` 该笔记的 outbox，仍有未发出的写入则抛 `conflict`（`saveDirtyBeforeDestructiveMutation`，`notes.ts:1690-1698`） |
| `notes.duplicate` | `POST /:id/duplicate` `{id?}` | `notes.ts:745` | 同名 | |
| `notes.emptyTrash` | `POST /api/notes/trash/empty` | `notes.ts:176` | 同名 | |
| `notes.versions` / `version` / `restoreVersion` | `GET /:id/versions`、`GET /:id/versions/:vid`、`POST /:id/versions/:vid/restore` | `notes.ts:826,845,870` | 同名 | |
| `notes.backlinks` | `GET /:id/backlinks` | `notes.ts:952` | 同名 | |
| `notes.flush(noteId?,options?)` | 等待本地日志提交，绕过网络防抖尝试回放 | — | `flush` | 返回 FlushResult `{pending,failed}`，不把 queued 当服务端确认；注销/破坏性操作另检查 pending |
| `notes.syncNow` | `SyncPuller.pull({force:true})` + `replay()` + 补拉确认结果 | — | `pull({force})` | 失败向调用方报告，后台触发不得产生未处理 Promise |
| `folders.list/create/patch/remove` | `GET/POST /api/folders`、`PATCH /:id`、`DELETE /:id?strategy=move-up\|delete` | `folders.ts:22,33,119,258` | `api.folders.*` | |
| `tags.list/create/patch/remove` | `GET/POST /api/tags`、`PATCH /:id`、`DELETE /:id` | `tags.ts:25,35,83,236` | `api.tags.*` | `PATCH` 响应是 `Tag` 或 `{ok,renamed}`，宿主归一化 |
| `search.query` | `GET /api/search?q=&limit=` | `search.ts:164` | `api.search` | |
| `search.graph` | `GET /api/graph?mode&center&depth&q&folderId&tag&includeOrphans&includeUnresolved&limit` | `search.ts:369` | `api.graph` | 布尔参数写 `1/0` |
| `search.reindex` | `POST /api/search/reindex` | `search.ts:603` | `api.reindex` | |
| `files.list` | `GET /api/files?cursor=` | `files.ts:270` | `api.files.list` | 返回 files 和 nextCursor；缺失 nextCursor 归一为 null，绝不只返回数组 |
| `files.upload` | `POST /api/files`（form：`file`、`noteId?`） | `files.ts:143` | `api.files.upload` | 上传前按 `LIMITS.attachmentMaxBytes` 预检，超限抛 `payload_too_large`，不发请求 |
| `files.remove` / `prune` | `DELETE /api/files/:id`、`POST /api/files/prune` | `files.ts:304,344` | 同名 | |
| `files.resolveUrl` | 无请求 | `files.ts:211` 提供 `GET /api/files/:id` | — | 原样返回 |
| `settings.get/save/stats` | `GET/PUT /api/settings`、`GET /api/settings/stats` | `settings.ts:28,33,60` | `api.settings.*` | `save` 成功后广播 `settings-changed` |
| `transfer.sources` / `exportTo` | sources 无请求，返回 files/folder；导出 `GET /api/export?format=zip\|json` | `transfer.ts:87` | `saveDownload` | zip 优先 `showSaveFilePicker` 流式写入，选择取消返回 null；否则 Blob + `<a download>` 并及时撤销 URL。文件名取 Content-Disposition，缺省 `autonote-backup.zip` / `autonote-export.json` |
| `transfer.importFrom('files')` | `POST /api/import`（form：`file*`、`conflict`） | `transfer.ts:129` | `api.transfer.import` | `<input type=file multiple>` 选择；取消返回 `null` |
| `transfer.importFrom('folder')` | 同上，另带 `backupManifest`、`backupPaths` | 同上 | `restoreMarkdownBackupFolder`（`lib/backup-import.ts:38`） | `<input webkitdirectory>` 选目录，按 50 个 / 8 MiB 分批（`backup-import.ts:34-36`），`onProgress` 报 `uploading` |
| `share.list/get/create/remove` | `GET /api/share`、`GET/POST/DELETE /api/share/:noteId` | `share.ts:55,72,82,151` | `api.share.*` | |
| `backup.*` | `GET/POST /api/backup/targets`、`PATCH/DELETE /targets/:id`、`POST /targets/:id/test`、`POST /test`、`POST /run`、`GET /runs` | `backup.ts:26-200` | `api.backup.*` | 方法名见 `10` §2 |
| `mcp.listKeys/getPreferences/savePreferences/createKey/revokeKey` 与 `mcp.remote` | `GET/PUT /api/mcp`、`POST /keys`、`DELETE /keys/:id`；remote：`GET/PUT /ai-search`、`POST /ai-search/reindex`、`POST /ai-search/clear`、`DELETE /grants/:id`、`POST /grants/revoke-all` | `mcp-settings.ts:31-157` | `api.mcp.*` | GET /api/mcp 已包含 apiKeys/preferences/grants；不得虚构 GET /keys。ID encodeURIComponent；token 仅创建时一次展示、不缓存、不记录 |
| `update.check` | `GET /api/update`（10 s） | `update.ts:11` | `api.update.check` | |

不进端口的请求：`GET /api/health`（CI 就绪探测）、`POST /api/public/:slug`（§6.2）、`GET /api/avatars/*` 与 `GET /api/files/:id`（作为 `<img src>` 直接访问）、`/api/sync/ws`（§5）。

### 4.5 读路径与离线启动

- `notes.snapshot(options?)`：先读用户隔离的 shell；有完整缓存就返回 `{full:true,hasMore:false,nextKey:null,cursor,notes,folders,tags,deletions:[],facetsFull:true,settingsChanged:false,profileChanged:false,siteChanged:false,serverTime}`。先注册 changes 再启动后台引擎，避免缓存返回与首个增量之间丢通知。无缓存则等待 §5.2 完整全量链，离线报 offline。
- `notes.get(id)`：优先叠加该用户 outbox 的最新有效文本/标题，在线 GET 结果只能刷新其基线，不能覆盖未上传正文；离线退回正文缓存并叠加日志。正文缺失时抛 offline，不能把摘要 excerpt 当正文。不同标签页冲突仍由依赖/版本恢复处理。
- shell 使用 `@app/state` 导出的 `mergeSync`（S6-1），遵守 full/facetsFull/deletions/rev 规则。只由 pull 推进远端 cursor；单个 HTTP 写响应与 write 事件不能合成 cursor。页面刷新后的 outbox 覆盖独立于可重建 shell 缓存。

## 5. SyncEngine 与唯一变更流

### 5.1 责任与生命周期

`HttpBackend` 持有一个 ChangeFeed 发布器，notes/outbox、SyncPuller、SyncEngine 只注入同一个 emit 函数。组件仅订阅 `backend.changes`，不直接订阅 TabBus、WebSocket 或写队列。引擎公开 `start()`、`updateConfig(realtimeEnabled,pollIntervalMs)`、`pullNow({force?})`、`stop()`；Backend.dispose 负责调用 stop、取消请求、关闭 bus 与释放其余宿主资源。start/stop 幂等；一次登录建立一个 user epoch，切账号递增 epoch，旧 pull/socket/回放结果不得写新用户缓存。

启动顺序：初始化语言/主题与平台接缝 → createWebBackend → mountApp 并注册 changes → session.load 绑定用户 → notes.snapshot → 启动引擎。匿名分享页不创建已登录 Backend；登录页只做会话请求，不选主和同步。settings 更新只 `updateConfig`，不重建引擎，避免重复 listener、socket 和定时器。

| 来源 | 对应用的通知 | 消费规则 |
| --- | --- | --- |
| 拉取完整全量/已合并增量 | `{kind:'sync',payload}` | NotesState.applySync；settingsChanged/profileChanged/siteChanged 驱动会话和设置刷新 |
| 入队、异步确认、恢复、失败 | `{kind:'write',payload}` | 按 noteId/writeId 更新保存状态，不作为新 cursor |
| settings/profile/site 广播 | `{kind:'settings'}` | SessionState/SettingsState 合并调度一次 load/get，保留更晚的本地设置补丁；刷新请求是 GET，不再广播 |
| 浏览器 online/offline、真实网络不可达 | `{kind:'connectivity',online}` | 展示网络状态；online 调度 pull/replay，不把 navigator.onLine 当服务端成功 |
| 桌面事件 | Web 不生产 library | `library` 是同一联合中的桌面事务通知，不由 Web 合成 |

### 5.2 分页、全量快照和提交点

`SyncPuller` 持有内存 shell、已应用 cursor、单飞 Promise 和 `forcePullQueued`。并发普通请求共享 Promise；进行中收到 force 必须再跑一次 since=0，不能丢掉强制意图。请求以 `{since,after?,snapshot?}` 发送，每个请求有 30 s 超时和用户 epoch；取消、错误后保留最后完整的提交点。

**增量链**：请求 `/api/sync?since=<appliedCursor>`；收到 full=false 后用 mergeSync 合并全部 notes/folders/tags/deletions。hasMore=true 则以该响应 cursor 继续，不能用开始请求时的 cursor 或 serverTime。cursor 不递增却 hasMore、重复 cursor 或非法整数视为 invalid_response，停止并保留先前正确页。中途转 full=true 切换全量流程，不把 full 页当普通增量丢掉。

**全量链**（worker 并非数据库 MVCC 快照，必须补增量）：

1. 第一页保存 `snapshotCursor=first.cursor` 和完整 folders/tags；notes 按 ID 聚合。每个后续请求固定 `since=0&after=<nextKey>&snapshot=<snapshotCursor>`，不能把 nextKey 填到 since。
2. hasMore 时 nextKey 必须非空且未访问过；后续页必须 full=true、cursor 等于首 cursor，否则报告快照失效。后续页的空 folders/tags 不是删除全部，只有首面的 facets 作为全量基线。
3. 读完全部页后，从 snapshotCursor 追增量到 hasMore=false；按顺序应用 facetsFull 替换、实体更新和墓碑。期间追增量又返回 full，丢弃未发布的暂存结果重来，最多两轮；持续变化报明确同步失败并保留旧 shell，不无限循环。
4. snapshotCursor=0 且无变化时允许直接提交；首次全量期间新建的数据由紧随的同步触发捕获。非零 cursor 必须完成补拉，防止分页中创建、删除或移动笔记造成全量假缺失。
5. 合成一个完整 `{full:true,hasMore:false,nextKey:null,facetsFull:true,...}` 才对 app 发布；在此之前绝不以局部 full 响应替换现有集合。settings/profile/site 标志 OR 合并，serverTime 取最后响应。

**缓存提交**：shell 的 notes/folders/tags/cursor 以同一 IDB `setMany` 事务写入；80 ms 合并只用于可重建 shell，不用于 outbox。写失败时旧缓存和旧 cursor 一起保留，内存可继续显示已拉取结果，但不能把新 cursor 单独写盘。下次启动从旧完整 checkpoint 重拉，重复增量依靠 mergeSync 幂等。全量聚合与增量 merge 不包含本地未上传正文；NotesState/notes.get 的 dirty 覆盖负责它们。

notes.list 的 nextCursor、files.list 的 nextCursor 与 sync cursor/nextKey 是不同分页域，全部保留原封套及类型，不相互转换。附件加载更多失败保持现有页及游标，可重试同页；只有成功应用后推进游标。

### 5.3 选主、实时和回退

沿用 参考项目 `lib/sync.ts`：BroadcastChannel 内 claim 以 `at` 降序、同值按 clientId 比较，260 ms 后决定领导者；focus 重新争主。只有 leader 建立 `/api/sync/ws`，URL 按页面协议选 ws/wss，使用同源 cookie，浏览器 WebSocket 不伪造 HTTP 自定义头。worker 验证 Origin 与 Upgrade。

- 收到 changed 只当拉取提示，过滤 `origin===clientId`；其 cursor 大于本地 cursor 时 180 ms 后 pull，不直接推进游标。非法消息记录汇总 debug 后丢弃，不进入业务状态。
- 心跳 25 s 发 ping；75 s 无 pong 关闭重连。退避 `min(30000,800*2^(failures-1))`，连通或 online 后清失败计数。失去领导权、关闭实时设置、stop 时清 socket/heartbeat/reconnect。
- polling 间隔 `max(5000,settings.sync.pollIntervalMs)`。隐藏页或非 leader 不做周期轮询；健康 WS 且最近 pull 不满 5 分钟则跳过，5 分钟安全轮询仍保留。focus/visible/manual 可在 follower 主动拉取，leader 退出无广播时另一页聚焦可接管。
- visible 延迟120 ms、focus200 ms、online50 ms；pulled 广播高于本地 cursor 则150 ms补拉但不再次广播 pulled。local-write 同页700 ms、其他页400 ms；profile/settings 分别沿用300/400 ms。调度保留最早截止时间并 OR 合并 shouldBroadcast，不能被后来的事件不断延后。
- BroadcastChannel 不可用时每页独立轮询/WS 属于允许的退化；防重复回放仍由独立 ReplayLock 保证。WS 缺配置或握手失败回退轮询，不把整个应用判为离线。
- 失败最终由引擎记录并保留重试入口；401 暂停并发 settings 触发 session.load，当前旧用户日志保留。网络恢复不自动切换用户。

## 6. 路由、公开分享与宿主接线

### 6.1 路由与组合根

`router.ts` 只解析 pathname：`/` 为应用，`/n/<26位Crockford ID>` 可带尾斜杠为笔记深链，`/s/<合法slug>` 为公开分享；`/__gallery` 仅 dev/test 可见。非法路径显示未找到而不是误提取前缀。`/api`、`/authorize`、`/oauth`、`/mcp`、`/.well-known` 由 worker 服务，不交客户端路由吞掉。

启动先判分享路径，再决定挂载 SharePage 还是 mountApp；深链在认证和 snapshot 完成后打开目标笔记，404/无权限保留明确错误，不能新建同 ID 空笔记。登录后继续原目标，未授权重定向不丢路径。`HostExtensions.onNoteOpened` 更新 `/n/:id`；popstate 使用共享 UiState 导航入口，避免 pushState→再次打开→pushState 循环。切换路径先 flush 本地编辑，取消过期加载，销毁旧 AppHandle/分享实例；刷新深链由 assets SPA fallback 提供同一外壳。

### 6.2 公开分享状态与安全

`SharePageState` 只依赖专用 public transport、Logger、Markdown 服务和 AbortSignal。加载 `POST /api/public/:slug`，JSON `{password?}`，保留 `X-参考项目-Client` 和同源 cookie。这个 HTTP 适配允许 password_required/password_invalid 两个公开页错误码，不污染已登录 Backend 的身份状态。

状态为 loading、passwordRequired、ready、unavailable、failed。无密码401显示密码输入；错误密码401保留重试但清敏感字段；429使用 retryAfter 提示，不自动暴力重试；404统一内容不可用；网络错误提供重试。每次加载取消上一请求并验证 generation，切 slug 后旧正文绝不能闪回。密码只存在当前内存和单次请求体，不写 prefs/URL/日志。卸载恢复自己设置的 document.title，不能覆盖后来页面设置的新标题。

复用共享 MarkdownArticle 与净化/增强管线，保留作者、站点、日期、字数/阅读时间、主题切换、代码复制/折叠、Markdown tabs、数学与 Mermaid 重试。公开页禁用任务编辑，并去除源行写入属性；私有嵌入只显示“未包含”，不调用 notes/get 或私有搜索。净化后的同源 `/api/files/<ID>` 的 img/a 增加 `share=<slug>`，不把 share 查询参数加到站外 URL；附件授权由 worker 原有分享 cookie/检查执行，不传密码到 URL。异步增强和复制反馈 timer 全部在卸载时取消。

worker `renderShareShell` 原样从新 index.html 注入 OG/Twitter。公开无密码笔记可含标题/excerpt；有密码、过期、撤销的链接不能泄漏它们。响应 no-store/noindex；客户端不能用静态 fallback 伪造私有分享 OG 内容。

### 6.3 原功能完整接线矩阵

下表列的是宿主连接责任，界面本身仍由共享任务实现，不重复写 Web 专用业务组件。

| 原功能 | 宿主连接/API | 共享消费方 | Web任务 |
| --- | --- | --- | --- |
| 登录注册、TOTP、恢复码、密码、头像昵称、站点注册开关 | session.account + session缓存/epoch | S6-4、S7-5、S9-3 | W2-2、W4-1 |
| 编辑/标题、双窗格、离线、复制、软删/恢复/清空、历史、反链 | notes 全方法 + outbox + changes | S5-1、S6-2、S8-1、S8-3 | W3-1、W3-2、W3-3、W4-1 |
| 文件夹树、拖拽排序/防环、颜色图标、标签重命名/删除 | folders/tags 方法，无新增rev | S6-3、S7-2、S7-3 | W2-3、W4-1 |
| 搜索、命令、图谱、重建索引 | search.query/graph/reindex，保留truncated/mode | S7-4、S9-4 | W2-3、W4-1 |
| 粘贴上传、图片预览、附件管理/分页/清理 | files 全方法 + 原 URL | S5-2、S8-2、S9-2 | W2-3、W4-1 |
| 语言、主题、编辑器/同步偏好、统计 | settings + WebPrefsStore + engine.updateConfig | S2-1、S2-2、S6-4、S9-2 | W2-2、W4-2 |
| JSON/ZIP导出、文件/目录导入和冲突策略 | transfer 全方法，取消null、批次进度 | S9-2 | W4-3 |
| 分享管理与匿名阅读 | share端口 + public transport | S9-3、共享MarkdownArticle | W4-3、W5-1 |
| WebDAV/S3目标、连接测试、手动备份/历史 | backup 全方法 | S9-3 | W4-3 |
| MCP开关/权限/API Key/OAuth撤销、AI搜索状态/重建/清空 | mcp基础 + remote，授权HTML由worker负责 | S9-3 | W4-3 |
| owner版本检查、部署更新、PWA安装与离线资源 | update + PwaPanel + build/deploy | S9-1、S9-3 | W4-3、W5-2、W6-1 |
| demo与生产相同界面、日志诊断 | 注入demo fetch/隔离存储；aboutPanels诊断 | S7-1、S9-1 | W5-3、W6-3 |

## 7. PWA

### 7.1 状态、安装与更新

`PwaState` 替换 Zustand 单例，由 main 装配并通过 `HostExtensions.aboutPanels` 提供 `PwaPanel.svelte`。字段保留 installAvailable/installed/installing、offlineStatus(idle/preparing/ready/error)、offlineCompleted/Total；方法 `start/requestOfflineWarmup/install/applyUpdate/dispose`。beforeinstallprompt 保存一次性 event，appinstalled 清它，display-mode 与 iOS standalone 判断仅在浏览器适配中使用。install 必须由点击触发，dismissed 不当失败；不支持安装提示时显示平台说明，不显示永远无效按钮。

仅生产构建且支持 Service Worker 时注册 `/sw.js`，scope `/`、updateViaCache `none`。监听 waiting/updatefound/statechange，提示更新但不自动刷新正在编辑的页面。用户“立即更新”先 `AppHandle.flush()` 等待本地提交；failed>0 或未持久失败阻止刷新。pending>0 但已有完整日志可刷新，同账号启动后继续回放；不要求为刷新先联网。成功后只向 waiting worker 发 SKIP_WAITING，controllerchange 且本页有更新意图时刷新一次。其他标签页不强制刷新，它们的旧静态 chunk 在资源缓存中保留到安全清理点。

### 7.2 资源清单与离线边界

从 参考项目 `pwa.config.ts` 移植生成器，插件名 `autonote:pwa`，保留缓存命名以便升级清理。删除 React 特定 CORE_LAZY_MODULES，改为实际共享 AppRoot/Workspace、语言包的构建模块，递归收集 imports、CSS 与 index 引用。核心资源保证应用外壳、登录、编辑器和语言能离线打开；可选 Mermaid/Prism/图谱等动态 chunks 由空闲 warmup 加载。buildId 对产物内容及 public 素材哈希，不靠部署时间缓存 bust。

核心安装并发4；可选资源预热复用现有单飞、进度消息 `GET_OFFLINE_CACHE_STATUS/WARM_OFFLINE_CACHE/OFFLINE_CACHE_STATUS`，完成才写当前 build manifest。失败显示 error，可 online/visible 重试；ready 只承诺静态界面资源，不承诺所有笔记正文/附件已下载。生产就绪后请求预热，requestIdleCallback timeout3s、不支持则1.2s；取消 idle/timer 是 dispose 的一部分。

GET 导航 network-first、失败回 `/index.html`；静态 hash 资源 cache-first。`/api/*`、`/authorize`、`/mcp`、`/oauth/*`、`/.well-known/*` 与站外一律 network-only，非GET不拦截；不缓存笔记/附件/公开分享正文/认证响应。`/s` 离线可展示公共外壳但读取明确失败，不能从旧缓存泄漏已撤销内容。更新激活只删旧 shell cache，不能清 IndexedDB/outbox；静态 asset 历史清理由已知 build 清单约束，不删除任意 origin 缓存。

## 8. Demo 模式

### 8.1 注入与隔离

保留 `demo/{backend,state}.ts` 的本地 Hono 模拟响应、欢迎笔记和演示账号行为，移植 runtime 时**不覆写 globalThis.fetch**。`main.ts` 在 `import.meta.env.MODE==='demo'` 动态加载 createDemoBackend，并将其 fetch 注入 HttpTransport/公开页 transport；生产 chunk 不引用演示密码和模拟处理器。IS_DEMO_MODE 只在组合根与宿主模块使用，共享界面不分支。

demo 的笔记/备份等操作均为演示内存状态，不向真正云端发出。启动显式重置 `autonote-demo` 缓存，页面刷新恢复演示初态并向用户说明；绝不调用 `autonote` 的 clear。为避免多页内存状态彼此覆盖，demo 用每实例内存 TabBus/ReplayLock，关闭 WS，不与真实 BroadcastChannel 通信；演示页间不承诺同步。文件 blob URL 由 demo runtime 维护并在重置/dispose 撤销；img/src、下载不能靠 HttpTransport 注入自动拦截，必须将模拟附件 URL 解析为受控 blob。

capabilities 对真实不能执行的 TOTP/远端网络任务按演示实现明确隐藏；已有模拟分享/备份/MCP设置保留演示反馈但不能宣称已备份到真实 WebDAV/S3。与原 demo 一样，“演示成功”只是本页面数据变化，界面显著显示 demo 标记和刷新重置说明。

### 8.2 构建与部署

`vite build --mode demo` 不加载 Cloudflare Vite worker 插件，输出 `web/dist/demo`，仍生成 PWA 静态清单。`wrangler.demo.toml` 是独立静态 assets 部署，name 为 `autonote-demo`、directory 指向 dist/demo、SPA fallback，不含 DB/R2/KV/AI/DO/cron。演示站与生产站使用不同 origin；不能在同源 `/demo` 注册 scope `/` 的 worker 覆盖生产 PWA。demo 深链由静态 fallback 进入同一 demo runtime，分享仅对当前页面初始/现存演示数据有效，不承诺跨浏览器真实分享。

## 9. 规范工具与边界执行

### 9.1 Web 分区规则

根 eslint/Prettier/Vitest 基础由 S0 建立，W1只扩 Web 规则，不另建第二套版本。TS浏览器新代码 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes；worker旧代码保持兼容编译范围。禁止具体网络/存储对象越层、console 越过 Logger、空 catch、any、floating promises、宿主深引用共享 feature 内部。window DOM 交互留在 route/PWA/平台实现，纯算法可 node 运行。Svelte5 runes、回调 props、attachment、组件长度规则与04一致。

### 9.2 i18n 扫描

改造 `web/scripts/check-i18n.mjs`，以 import.meta.url 解析仓库路径，不依赖调用 cwd；扫描 packages/app 与 web/client 的 .ts/.svelte，语言包统一 packages/shared/locales。TS 使用 TypeScript AST；Svelte 使用 svelte/compiler 的 parser 遍历 script/module script、Text、Attribute、Expression，提取 t 调用、可见字串和 aria/placeholder/title，报告原文件行列。不能用正则剥标签或把整份 Svelte 喂 TS parser。

检查双语言键集合、插值占位符一致、无模块级冻结语言 t、可见字串已本地化；动态 key 限定为可证明的 MessageKey 集合。OAuth自带语言页面保留精确路径/片段白名单，移动文件更新白名单，不全目录忽略。设计文档可中文，不把 docs 纳入源码英文检查。fixtures 中未知键、嵌套插值、snippet和注释内文本需区分，不把用户Markdown样例当界面常量误报。

### 9.3 注释检查与质量门

`check-comments.mjs` 保留现有 worker 精确注释白名单，迁移后路径重映射并删除已不存在批准项。TS由scanner/AST取注释，Svelte通过解析器定位 HTML注释、script注释、style CSS注释，不把URL、字符串或Markdown代码块中的 `//` 当注释。CSS/HTML/TOML检查保持原规则；合法公开API说明、重要边界注释逐条批准，不为了清零诊断删除必要文档。

实施质量门统一根 `web:check`、`web:test` 与真实 `web/scripts/e2e.mjs`；新增脚本检测器用行为输入/输出验证而非源文本快照。设计阶段不执行它们。无 API 改动不代表可以跳过原 worker e2e；UI还需实际浏览器交互与截图，单元测试不能代替。

## 10. 升级、会话安全与部署

### 10.1 同源升级

协议前缀、IDB库/store/key、outbox字段和 BroadcastPayload 保持兼容；用户可见品牌/图标/下载文件名改 AutoNote。HTTP SiteInfo 不扩大 local，Web把 SessionInfo 作为 BackendSession 的合法子集返回。生产升级默认原 origin、原 cookie、原D1和附件绑定；换 origin 无法访问旧浏览器日志，部署说明必须先在旧站完成同步，不能宣称跨域自动搬迁。

LocalDb.bindUser 捕获明确 userId/epoch；所有异步写使用捕获的命名空间，不能在 await 后重新读取“当前user”导致串号。旧无前缀数据迁移采用写新键成功后再删旧键，覆盖冲突优先保留用户作用域现存日志并合并不同槽位；同槽位按 writeId/createdAt 识别，不用空数组覆盖新队列。迁移中断重试幂等，无法确认归属的旧日志保留、禁止绑定给任意新用户。未知字段保留，损坏日志显式失败。

### 10.2 注销、认证失效与破坏性操作

**主动注销**先由共享 SessionState 显示待同步数，让用户选择取消或尝试同步后注销；不提供“继续并丢弃”。SettingsState.flush 先完成设置在线写入，失败保留本地待修改状态。宿主 session.logout 单飞：等待所有本地提交 → 绕过防抖尝试回放 → 重新读取该用户全部标签页 outbox → pending/failed非零或读取失败时拒绝注销，显示恢复/联网重试，不发 logout POST。已认证但离线时无法完成服务器注销，保持会话与数据。

只有确认待上传为空后 POST logout，成功再清 session缓存与本页内存、停止引擎，**不清任何用户命名空间 outbox**，也不调用数据库 clear。保留此规则可保护其他旧标签页在检查后刚入队的竞态数据；它们被服务器401拒绝后仍能重新登录原账号回放。普通可重建缓存可在无日志时按用户定向失效，不做全库清除。logout请求失败保持当前状态；响应丢失后下次session.load为anonymous，仍不删日志。

**被动401/其他标签页注销**取消当前epoch网络请求并退回认证，不把cached session当认证通过继续在线写。离线启动只在网络不可达且缓存用户与绑定一致时可展示本地内容；明确的anonymous/401覆盖会话缓存，不清正文和outbox。新账号登录只能访问自己的命名空间，旧日志保留直到旧账号重新登录。Backend.dispose 只释放资源并等本地提交，不等网络清空，也绝不删除日志。

remove/restore/purge/restoreVersion/emptyTrash、删除文件夹并删子笔记、标签改名或删除会改变正文的操作，先flush受影响笔记。pending/failed仍非零则conflict并不发破坏性请求，避免 outbox 在删除之后复活或覆盖历史恢复。无法安全枚举目标时检查整个用户队列；普通在线元数据操作不享有强制 rebase 权限。

### 10.3 构建产物与发布

Web Vite保留Svelte/Tailwind、Cloudflare插件和 `AUTONOTE_EPHEMERAL_DEV`，补 @app/@shared 别名；dev/kv/ai/demo配置分开。按目前 `web/package.json`，deploy硬编码 `dist/autonote/wrangler.json` 不适合用户自定义worker name；W6-1改成 `scripts/deploy.mjs` 从**本次模式构建**定位唯一生成的 wrangler.json，校验name/assets目录，再调用锁定版本wrangler。零个/多个候选直接报配置错误，不能随便选旧产物。dry-run不发发布请求；demo使用独立配置而不探生产worker输出。

默认R2与KV附件配置都要保持绑定名称；AI可选、无SYNC_HUB轮询回退；OAuth provider、credential vault、cron、MCP路由与run_worker_first白名单不因前端改写而移除。用户现有D1/R2/KV ID和secrets从原配置保留，不写示例值冒充真实资源。产物客户端不能包含服务端密钥或完整源码map，demo代码不得进入生产入口。

发布顺序：在隔离测试实例备份数据 → 原worker/API契约回归 → 两种存储模式构建与dry-run → 浏览器实际新PWA/旧PWA升级 → 部署已校验产物。回滚只回滚worker/assets版本，不回滚或清空用户IDB/D1；已保留旧字段的日志可由旧版读取。部署文档记录同源升级、待同步提示、PWA等待激活、绑定与回滚过程；本设计不声称已验证具体依赖组合或已部署。

## 11. 日志与诊断

`ConsoleRingLogger implements Logger` 是唯一console使用处，固定200条环形缓冲，超限覆盖最老；不另建遥测服务/上传端点。每条含time/level/event和允许的扁平字段。默认debug不输出；构造环境控制诊断级别。aboutPanels注入诊断下载动作，以Blob生成JSON并撤销URL，文件仅包含应用版本、浏览器能力和脱敏记录，不混入数据库内容。

| 事件 | 级别 | 安全字段 | 最终处理层 |
| --- | --- | --- | --- |
| host.lifecycle.started/disposed | info | mode,durationMs | main |
| local.read.failed / local.migration.failed | warn/error | keyKind,code,count | LocalDb边界 |
| outbox.enqueue.failed | error | noteId,writeId,code | notes写入协调者 |
| outbox.replay.completed | info | count,pending,durationMs | Replayer每轮汇总 |
| outbox.replay.rebased/recovered | warn | noteId,writeId,rev,reason | Replayer恢复分支 |
| outbox.replay.failed | error | pending,attempts,code | Replayer最终失败层 |
| sync.pull.completed/failed | info/warn | full,pages,cursor,count,durationMs,code | SyncPuller/调用边界只记一次 |
| sync.socket.fallback | warn | code,delayMs | SyncEngine |
| pwa.registration.failed / pwa.cache.failed | warn | code,completed,total | PwaState |
| transfer.operation.completed/failed | info/error | jobId,phase,count,durationMs,code | transfer端口 |

禁止正文、标题、完整URL查询串、Authorization/cookie/token、密码/TOTP、备份凭据和原始Response/Error对象。资源ID可记录但日志导出仍提示用户可能含标识信息。任意fields输入先按允许键/值类型净化，凭据整项删除，不截头尾掩码。share密码错误只记code，不能记请求体；下载文件名/附件原名不进日志。循环内汇总，恢复型冲突不再由transport重复error；应用toast与日志是两个渠道，用户只收到一次通知。

## 12. 设计裁决

| 问题 | 明确结论 | 原因与影响 |
| --- | --- | --- |
| 是否逐字复制旧控制流 | 保留数据/HTTP协议和有效恢复语义，不复制清库/吞错/迟到确认缺陷 | 兼容旧日志不等于允许数据丢失；§3、§10规定安全边界 |
| 两条写事件总线 | 不设notes.watchWrites，不设kind=notes；全部走changes | 单一生命周期与writeId关联；§5.1 |
| queued和自动保存 | writeId由app生成；IDB立即提交，queued只表示本地持久；网络单独防抖 | 页面关闭不依赖最后一发定时器；§3.3 |
| flush和logout | FlushResult.pending/failed显式返回；刷新可保留pending，主动注销必须先同步完且从不清outbox | local-safe与remote-confirmed是不同保证；§7、§10.2 |
| 取消/超时/坏JSON | 使用客户端ErrorCode cancelled/request_timeout/invalid_response | 不扩大worker HTTP错误，避免错误当offline排队；以10 §2为准 |
| 列表解包 | notes.list、files.list保留分页封套；只有无分页数组解包 | 丢游标会截断用户数据；§4.4、§5.2 |
| full页是否立即广播 | 不；完成全部nextKey页并追cursor增量后发布完整full | worker不是冻结快照，后续空facets也不是删光；§5.2 |
| 409冲突策略 | 只有outbox回放可rebase且preserveVersion；普通GUI元数据冲突返回调用方 | 不静默覆盖并保留服务端历史；§3.5 |
| title-only无缓存 | 可以入队但contentDirty=false，不发送空正文 | 不需要为改标题强制联网；§3.3 |
| demo截获全局fetch | 不；注入传输并专门处理blob附件，独立origin | 不污染生产、避免图片绕过fetch注入；§8 |
| PWA实现选择 | 迁移现有生成器，不另引整套workbox；重写Svelte核心chunk识别 | 保留已有离线与升级语义，无多余抽象；§7 |
| 公开分享复用业务壳 | 不挂载登录态Backend，只复用Markdown基础能力 | 不拉用户私有数据；§6.2 |
| 旧广播conflict恢复取值 | 仅接受旧消息作为补拉提示，不扩新WriteQueueEvent联合 | 当前共享契约只有deleted；§3.6 |
| 是否改变worker路由 | 不改；完整端口映射现有API，MCP keys从GET /api/mcp解包 | 减少迁移风险、维持参考项目和桌面同步兼容 |

## 13. 实施计划

本组在全部设计定稿后执行。共 W1–W6，每组3项；真实运行判据须凭命令/浏览器证据确认，本轮代码交付与尚未运行项见 §14。共享任务ID按10冻结。

### W1-1 Web平台边界与工程接缝

- **依赖**：S0-1、S0-2、S0-3、S1-1、S1-2、S1-3。
- **改动范围**：`web/src/client/{runtime.ts,platform/,log/console-ring-logger.ts}`、根`eslint.config.js`的Web分区、`web/tsconfig.client.json`、`web/package.json`。
- **不做**：共享组件、worker重构、outbox业务、独立工具版本。
- **步骤**：1. 实现Clock/Timers/PageSignals/WebPrefsStore浏览器适配和资源清理。2. 实现§11 Logger并暴露目录index入口。3. 添加只允许适配文件直接使用浏览器持久/网络对象的规则，保持worker编译范围不变。
- **判据**：实施时运行Web检查；浏览器真实写布局后刷新恢复、阻止localStorage时显示安全降级；监听卸载后不再触发；日志200条覆盖最老且注入凭据字段不会出现在导出数据。
- **陷阱**：把日志正文当fields透传；window timer返回值与node句柄混用；prefs不可承载笔记正文或会话。

### W1-2 Svelte与共享包i18n检查

- **依赖**：W1-1、S2-1。
- **改动范围**：`web/scripts/check-i18n.mjs`、检测器行为测试、根和Web package检查脚本。
- **不做**：复制语言包、正则剥Svelte标签、将设计文档改英文。
- **步骤**：1. 从参考项目迁移TS检测与语言键/插值校验。2. 用Svelte parser覆盖模板、script、snippet、可见属性并保留位置。3. 扫描app/web共享语言根，重映射精确OAuth白名单与动态键规则。
- **判据**：实施时从根/Web两个cwd运行同一命令得到同样结果；嵌套Svelte未知键、遗漏aria翻译、插值不一致都能失败并定位真实行；合法动态集合/代码样例不误报；实际中英切换不冻结首屏文字。
- **陷阱**：只扫.ts漏模板；把模板表达式的偏移当原文件行；共享语言包被两份词典覆盖。

### W1-3 注释扫描与检查入口收敛

- **依赖**：W1-1。
- **改动范围**：`web/scripts/check-comments.mjs`、其行为用例、`web/package.json`及根Web检查入口。
- **不做**：重写未改worker注释、删除必要说明换取通过、用整目录白名单。
- **步骤**：1. 搬迁既有白名单并按实际新路径定位。2. 解析Svelte HTML/script/style注释及TS/CSS/HTML/TOML，区分URL和字串。3. 删除失效批准项，接入统一质量门。
- **判据**：实施时检查器拒绝未经批准的模板/script/style注释，批准的公开API说明通过；字符串里的https://和Markdown示例不被误判；实际Web检查入口包含两项扫描器且错误退出码传播。
- **陷阱**：注释规则不能绕过04公开API文档要求；parser版本和Svelte版本锁定一致性需实际验证。

### W2-1 HTTP传输、错误与用户本地存储

- **依赖**：W1-1、S1-4。
- **改动范围**：`web/src/client/backend/{transport,errors,tab-bus}.ts`、`web/src/client/local/`、Web依赖中的idb-keyval。
- **不做**：笔记回放、Svelte业务状态、改变cookie/HTTP头或worker错误。
- **步骤**：1. 实现§4.2请求头、JSON/FormData/下载、timeout/abort清理。2. 映射§4.3机器错误并只透传安全details。3. 实现用户命名空间、旧键迁移、shell原子checkpoint、真实BroadcastChannel与可测替身。
- **判据**：在隔离本地worker真实请求验证401/409 details、FormData上传和取消/超时区分；浏览器旧IDB迁移中断重开后日志仍存在；换账号看不到前用户缓存；坏日志拒绝空队列成功路径。
- **陷阱**：GET空body被JSON.stringify；FormData手填Content-Type；await后取当前user造成串号；明文details泄漏SQL。

### W2-2 会话、账号、设置与注销闸门

- **依赖**：W2-1、S6-4。
- **改动范围**：`web/src/client/backend/ports/{session,settings}.ts`、`backend/index.ts`、`local/local-db.ts`。
- **不做**：登录UI重写、离线注册/改密码、清空其他用户缓存。
- **步骤**：1. 接通§4.4全部登录/注册/TOTP/恢复码/密码/资料/注册开关方法及BackendSession。2. 设置读写按SettingsPatch保留未确认补丁与epoch，成功广播并更新同步配置。3. 为logout注入flush/pending检查接缝，实现§10.2保留日志闸门；W3-3接入真实回放后联合验收。
- **判据**：真实登录→TOTP挑战→恢复码→资料更新及切账号无旧响应覆盖；设置保存失败不抹后续输入；pending非零时logout不撤销会话，成功logout也不清用户日志；401后重新登录同账号可重新取得日志。
- **陷阱**：用cached session掩盖真实401；settings乐观成功冒充远端确认；主观“用户已确认”成为删除日志借口。

### W2-3 组织、查询、附件分页端口

- **依赖**：W2-1、S6-3、S9-4。
- **改动范围**：`web/src/client/backend/ports/{folders,tags,search,files}.ts`、端口行为用例。
- **不做**：附件离线队列、客户端模拟文件夹rev、私有API重命名。
- **步骤**：1. 对照api.ts接通folder/tag全部输入和返回封套归一化。2. 接通search/graph/reindex，保留query布尔规则、截断与取消。3. 接通files上传/URL/列表分页/remove/prune、size预检和存储不可用错误。
- **判据**：真实树移动/防环/子树删除、标签重命名后正文与计数一致；检索和图谱包含真实边界；大于一页附件能够读到最后一个且失败重试不重复丢页；上传后读回哈希一致，删除仍被引用对象遵守服务器结果。
- **陷阱**：把AttachmentPage解成数组；tag.patch的renamed响应强转Tag；上传失败生成虚假成功链接。

### W3-1 文本持久队列与缓存覆盖

- **依赖**：W2-1、S6-1、S6-2。
- **改动范围**：`web/src/client/outbox/{types,outbox-store,order}.ts`、`backend/ports/notes.ts`写入部分、`local/local-db.ts`正文缓存。
- **不做**：WS/选主、网络409/404恢复、把metadata/附件塞入outbox。
- **步骤**：1. 保留旧字段与未知payload，单键原子enqueue/complete/revision/dependent更新。2. 接收app writeId，立即入队返回queued，再独立调度网络防抖。3. 实现title-only无缓存、日志优先正文读、同槽位后续输入保护和FlushResult本地持久部分。
- **判据**：浏览器断网输入后在网络防抖到期前刷新，正文/标题恢复；伪造quota失败不能显示saved-local；只改标题不覆盖服务器正文；旧writeId完成不能删新条目；拓扑依赖和环不导致无限回放。
- **陷阱**：同一个定时器兼管落盘和发送；缓存失败撤销已成功日志；坏日志被归一成空数组。

### W3-2 互斥回放、冲突历史与恢复副本

- **依赖**：W3-1。
- **改动范围**：`web/src/client/outbox/{replay-lock,replayer}.ts`、`backend/tab-bus.ts`的outbox消息消费。
- **不做**：修改worker CAS协议、普通GUI冲突自动rebase、共享第二事件总线。
- **步骤**：1. 实现Web Locks与IDB租约退化、单飞轮次和writeId条件完成。2. 实现200、已确认409、preserveVersion rebase、401暂停和失败保留。3. 持久recoveryId后创建副本、广播结果、获取完整copy发统一write事件。
- **判据**：两个真实浏览器标签页争抢相同日志只形成正确版本推进；A编辑离线而B改同笔记时回放后本地新文胜出且B版本可读；远端删除后刷新/重复回放只产生同一恢复ID，后续输入不被旧确认抹掉；401不清队列。
- **陷阱**：租约过期后旧owner继续发送；complete无writeId比较；POST恢复成功响应丢失后重新生成副本ID。

### W3-3 完整笔记端口、破坏操作与保存联验

- **依赖**：W3-2、W2-2、W2-3、S8-3。
- **改动范围**：`web/src/client/backend/ports/notes.ts`剩余snapshot/list/get/create/remove/restore/purge/duplicate/emptyTrash/versions/version/restoreVersion/backlinks/flush/syncNow、`sync/{full-sync,puller}.ts`、`backend/index.ts`。
- **不做**：编辑器UI、额外历史恢复rev参数、依靠pagehide保证最后落盘。
- **步骤**：1. 实现§5.2全量/增量puller与snapshot、syncNow，再逐项接通§4.4笔记方法并保留ListNotesResponse。2. 将真实flush/pending检查接入注销和所有正文破坏操作。3. 统一queued/直接确认返回值和write事件，旧HTTP结果只确认自身writeId。
- **判据**：真实创建/复制/软删/恢复/版本恢复/彻底删与反链显示正确；未上传日志时注销、清空垃圾箱和恢复版本被安全阻止；同步清空后可注销再登录，无正文丢失；列表分页能加载完整集合。
- **陷阱**：restoreVersion改变正文而忘记先flush；purge cursor当note rev；clear调用删掉另一个标签页刚提交的日志。

### W4-1 组合根、路由与全部共享界面挂载

- **依赖**：W3-3、W4-2、W4-3、S7-1、S7-2、S7-3、S7-4、S7-5、S8-1、S8-2、S8-3、S9-1、S9-2、S9-3、S9-4。
- **改动范围**：`web/src/client/{main,router}.ts`、`web/index.html`、`backend/index.ts`、宿主扩展入口。
- **不做**：复制共享业务组件、上线图库充当首页、改worker登录路由。
- **步骤**：1. 装配AppDeps/Backend及唯一changes，首屏主题和语言初始化后挂载真实AppRoot。2. 接通深链、onNoteOpened/popstate、登录后回原目标和错误边界。3. 逐项按§6.3矩阵连通编辑/导航/设置/图谱，并清理旧骨架入口与重复资源。
- **判据**：实际浏览器宽/中/窄三档完成登录、打开深链、输入、切笔记、双窗格、命令、设置和返回导航；刷新正确目标且未保存正文安全；注销后不会留旧账号正文；退出/重挂无双listener或重复保存。
- **陷阱**：snapshot先于changes订阅导致首包丢失；DOM就绪不等于共享状态就绪；pushState回调自激循环。

### W4-2 分页同步、跨页选主和实时回退

- **依赖**：W3-3、S6-1。
- **改动范围**：`web/src/client/sync/{engine,leader,socket}.ts`、`backend/index.ts`、settings/profile/site广播转换及puller联验。
- **不做**：直接改共享状态内部字段、假造sync cursor、为WS改worker API。
- **步骤**：1. 接入W3-3已有分页puller/checkpoint并验证force单飞与引擎调度。2. 迁移选主、心跳、退避、轮询和生命周期参数。3. settings/profile/site改用统一事件，stop/dispose按epoch释放全部资源。
- **判据**：真实多于syncBatchSize数据、分页中删除/新建/改facets后无丢项；中途断网重启从完整checkpoint续拉；两页只一leader建WS，关闭/聚焦后接管；禁用实时或无DO仍轮询可见变更；改变设置不重建双socket。
- **陷阱**：nextKey当cursor；后续full页空folders清掉整棵树；无pong仍当健康；收到pulled再广播无限回环。

### W4-3 导入导出、分享管理与全部云端设置

- **依赖**：W2-3、W3-3、S9-2、S9-3。
- **改动范围**：`web/src/client/backend/ports/{transfer,share,backup,mcp,update}.ts`、`backend/download.ts`、目录导入适配与设置接线。
- **不做**：桌面快照格式设计、真正上传demo备份、手写MCP协议客户端。
- **步骤**：1. 迁移JSON/ZIP下载、文件/目录选择及backupManifest/backupPaths分批、取消与ProgressEvent。2. 接通share和backup全方法。3. MCP基础/remote按GET /api/mcp聚合接口拆分、一次token展示与OAuth撤销；接owner更新检查。
- **判据**：真实导出再导入内容/附件哈希互通；取消选择不发请求且返回null，半途取消已提交批次计数真实；分享创建/撤销正确；隔离WebDAV/S3测试目标成功与凭据错误均可见；MCP key创建后可授权并撤销，AI不可用状态正确；非owner无更新入口。
- **陷阱**：丢备份路径导致附件断链；Abort只丢Promise但请求仍运行；构造不存在的GET /mcp/keys；日志泄漏token/目标凭据。

### W5-1 匿名分享页与公开Markdown行为

- **依赖**：W4-1、W4-3、S4-1、S4-2、S3-1、S3-2。
- **改动范围**：`web/src/client/share/`、`router.ts`公开入口、public transport。
- **不做**：挂载登录态NotesState、私有嵌入解析、缓存分享密码或改worker OG模板。
- **步骤**：1. 实现§6.2状态机和并发取消。2. 复用MarkdownArticle增强、只读任务、私有嵌入提示与share附件URL。3. 接作者/统计/主题/代码复制、标题恢复和生命周期清理。
- **判据**：无痕窗口真实打开公开/带密/过期/已撤销分享；错误密码与429提示符合行为；附件合法可读、非共享附件不可读；任务无法编辑、私有嵌入不发私有API；有密码页OG不泄漏标题，切路由无旧正文回闪。
- **陷阱**：只靠readonly CSS仍触发任务写入；把share参数加到外站；卸载后Mermaid插回新页面。

### W5-2 PWA离线资源与安全更新

- **依赖**：W4-2、W5-1、S2-2、S9-1。
- **改动范围**：`web/pwa.config.ts`、`web/src/client/pwa/`、`web/public/manifest.webmanifest`、Vite插件接线。
- **不做**：缓存API/附件/口令、自动刷新丢掉编辑、清理IDB、另引PWA框架。
- **步骤**：1. 迁移生成器并按Svelte/app模块重建核心资源图。2. 实现安装/预热/进度/更新状态和aboutPanel。3. 更新前等待AppHandle.flush，本地失败阻止激活，dispose清全部listener/timer。
- **判据**：真实production preview安装后断网重开，已缓存正文可编辑且重新联网回放；核心与可选Markdown功能在预热后可用；两个构建版本真实升级不丢pending；配额失败阻止刷新；DevTools确认认证/API与分享正文不在Cache Storage。
- **陷阱**：仍按.tsx后缀找核心chunk；首次安装自动刷新；controllerchange导致全页循环；把offline ready描述成全量数据备份。

### W5-3 Demo完整注入与静态发布

- **依赖**：W4-3、W5-1、W5-2。
- **改动范围**：`web/src/client/demo/`、`runtime.ts`、`main.ts`、`web/wrangler.demo.toml`、Vite demo模式与package脚本。
- **不做**：改global fetch、真实账号注册/远端备份、生产同源子路径部署demo。
- **步骤**：1. 迁移demo state/backend并注入fetch及附件blob解析。2. 独立存储/内存bus/lock，关闭WS，启动只清demo缓存并展示刷新重置说明。3. 创建无绑定静态demo部署配置与独立构建。
- **判据**：实际静态服务器打开demo完成登录、编辑、附件、分享、设置和导入导出演示；刷新恢复初态；Network不访问生产API/WS；同浏览器生产IDB内容前后不变；演示附件可显示且重置后旧blob撤销。
- **陷阱**：HttpTransport注入不覆盖img src；相同固定demo userId导致跨页状态串联；demo bundle含生产secret或生产bundle夹带演示处理器。

### W6-1 多配置构建与部署定位

- **依赖**：W1-2、W1-3、W5-3。
- **改动范围**：`web/scripts/deploy.mjs`、`web/vite.config.ts`、`web/package.json`、`web/wrangler.toml`/`wrangler.kv.toml`与既有部署说明。
- **不做**：改用户资源ID/secrets、删除生产数据、硬编码新worker name绕过产物定位。
- **步骤**：1. 保留dev/ai/kv/demo模式并识别本次构建生成配置。2. deploy/dry-run验证唯一name/assets路径及输出新鲜度后执行wrangler。3. 记录§10.3同源升级、绑定、PWA和回滚步骤。
- **判据**：实施时默认R2/KV/demo三种实际构建与dry-run通过；临时自定义worker name不依赖dist/autonote；存在多个旧候选时拒绝误部署；真实隔离实例health、deep link、OAuth/MCP路由与assets均能到达。
- **陷阱**：按目录扫描随意选最近wrangler.json；删除AI绑定泄漏到生产配置；run_worker_first漏/s导致OG失效。

### W6-2 升级与全功能真实验收

- **依赖**：W6-1、W4-2、W4-3、W5-1、W5-2、W5-3、S1-4。
- **改动范围**：`web/scripts/e2e.mjs`、Web行为/契约场景、既有验收与部署说明。
- **不做**：源码匹配式测试、伪Backend冒充HTTP证据、修改生产账号/数据。
- **步骤**：1. 保留原worker有效e2e，追加真实端口/分页/队列/账号切换回归。2. 在旧参考项目同源浏览器数据上升级新构建，含未回放日志/损坏条目/旧PWA。3. 按§6.3完整矩阵和三档宽度做浏览器键盘/鼠标与视觉验收，记录实际结果。
- **判据**：所有原功能入口有可执行结果；离线刷新/409历史/404副本/分页补拉/注销阻止/再登录续传均通过；真实HTTP与shared行为契约一致；发布资源和旧日志安全兼容；仅已实际运行项记为完成。
- **陷阱**：把全套API通过当UI完成；只验新安装忽略升级；为了条数保留失效文案断言。

### W6-3 诊断导出与宿主生命周期收口

- **依赖**：W6-2、W1-1、S9-1。
- **改动范围**：`web/src/client/log/`、宿主aboutPanels、`main.ts`销毁/错误收口与既有诊断说明。
- **不做**：遥测服务、自动上传日志、未请求的历史数据清理。
- **步骤**：1. 按§11对请求/队列/同步/PWA/迁移最终处理层接结构化日志并消除重复。2. 提供200条诊断导出与明确敏感信息提示。3. 完整AppHandle.destroy→Backend.dispose清理序列在正常退出、错误重挂、分享切换中复用，删除迁移期间临时脚手架。
- **判据**：真实制造离线/401/迁移失败各产生一次可追踪且无正文凭据的日志；导出超过200条时仅保留最新；多次重挂后无幽灵WS/轮询/重复toast；dispose前本地提交失败明确阻止销毁，已持久pending不因退出被清除。
- **陷阱**：dump原始Error/Request泄密；debug循环刷屏覆盖真正故障；为清理资源先清队列或把dispose挂在不可靠unload异步等待上。

## 14. 本轮代码交付与待运行验收

以下记录代码已接线，不代替 §13 的真实验收，也不据此勾选 `03`。本轮未执行测试、构建、lint、dry-run 或浏览器检查；由主线程在全部模块落地后统一执行。

- **W4-1 / W4-3**：组合根在判断路由后才创建登录 Backend，深链等待共享 AppHandle 就绪；匿名页只构造 public transport。所有端口复用现有 Worker 路由；下载中断括号已修复，目录导入校验 COMPLETE、manifest 和哈希，附件先于笔记分批；破坏性文件夹/标签写入先检查完整用户 outbox。导出选择取消返回 null，已提交导入批次在取消后计数保留。真实导出/导入附件哈希、WebDAV/S3 隔离目标、MCP 授权撤销仍需 §W4-3 联验。
- **W4-2**：`WebBackendDeps.sockets: SocketFactory | null` 明确注入；生产用公开入口的 `browserSocketFactory`，demo 传 null。实时能力表示可建立通道，不冒充当前已连接；无 DO/握手失败按轮询回退。leader、心跳、最早截止调度、设置/账号 epoch、完整分页 checkpoint 与统一 changes 已接线。执行 `pnpm --filter autonote-web test:unit` 后还需两个真实页面验证单 leader、聚焦接管、无 pong、无 DO 与大于 syncBatchSize 的分页中变更。
- **W5-1**：`SharePageState` 对 401 密码错误、429 retryAfter、404 与网络错误分支；请求取消与 generation 防迟到正文。分享只使用 `/api/public/:slug`，不创建 NotesState 或登录 Backend；共享 `MarkdownArticle.publicReadonly` 禁止任务/私人 Wiki/嵌入/标签写入，services 不访问私有笔记。附件仅精确同源文件路径添加 share，标题仅恢复自己设置的值；倒计时结束后仅开放人工重试，不自动猜口令。运行 share/router 行为测试，仍需无痕窗口公开/口令/过期/撤销与 OG、附件权限、路由销毁真实验收。
- **W5-2**：`autonotePwa()` 已在 Vite 接线；Svelte/app 核心资源图、产物内容 hash、可选静态预热、build 清单限定历史缓存。PwaPanel 通过 `HostPanel.props.state` 注入；waiting 更新点击后等待 AppHandle.flush，failed 阻止、已持久 pending 可刷新，只有本页更新意图刷新一次。API、认证、附件和分享正文均 network-only，永不清理 IDB。运行 pwa 状态用例后，仍需真实 production preview 安装、断网缓存编辑/回放、两个版本升级、配额失败与 Cache Storage 审核。
- **W5-3**：`createWebServices()` 仅 demo 模式动态载入 `createDemoRuntime()`，不覆盖 global fetch；只清 `autonote-demo`，生产 `autonote` 不动。独立内存 bus/lock、关闭 WS、TOTP/真实 AI/更新能力隐藏；本页备份/MCP 设置明确演示反馈。附件预解析受控 blob 并 dispose 撤销；公开初始示例 `/s/00000000000000000020`。demo 登录使用 `admin` / `password`，生产 bundle 不静态引用演示处理器。`pnpm --filter autonote-web build:demo` 后用 `pnpm --filter autonote-web preview:demo` 在独立 origin 验证登录、编辑、附件、分享、设置、JSON/ZIP/目录导入导出、刷新重置及 Network 无私有 API/WS。
- **W6-1**：`deploy` / `deploy:kv` / `deploy:demo` 经 deploy.mjs 构建本次 mode，验证唯一新鲜 Wrangler 配置、name/assets/source/绑定/路由后才发布；本轮禁止执行这些发布命令。统一验收使用 `build`、`build:kv`、`build:demo` 以及 `deploy:check`、`deploy:check:kv`、`deploy:check:demo`（均 dry-run，不发布）。旧多个配置拒绝误选，脚本不删除旧目录；原 R2/KV 资源 ID/绑定保留，demo 独立无绑定。临时自定义 name、旧候选拒绝、隔离 health/deep link/OAuth/MCP 实测仍待运行。
- **W6-3**：ConsoleRingLogger 仅保留最新 200 条；fields 按允许键、有限数值、ErrorCode/资源 ID 净化，原始错误/正文/标题/URL/凭据不导出。about 诊断只包含版本、浏览器能力与净化记录，Blob URL 使用后撤销。路由切换统一等待 destroy 成功才释放资源，Backend.dispose 先等待本地日志提交，失败保留旧 UI/资源；退出不清 outbox、不以 unload 异步当持久保证。运行 logger/生命周期行为用例后，仍需真实离线/401/迁移失败去重与反复重挂无幽灵 WS/轮询/通知。

生产升级沿用原 origin、cookie、D1 和附件绑定；切换 origin 前先在旧站同步待上传日志。发布前在隔离实例备份、API 回归和 R2/KV dry-run，再人工验证旧 PWA 等待激活与 pending 恢复。回滚仅 Worker/assets 版本，不回滚或清空用户 IDB/D1。上述命令与场景未运行，不宣称已部署或验收通过。
