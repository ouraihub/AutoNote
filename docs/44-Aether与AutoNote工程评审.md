# 44 Aether v0.1.1 与 AutoNote 工程评审

> 日期：2026-11-02
> 范围：Aether v0.1.1 对公共 TS、Rust Native、Tauri plugin、AutoNote Web/桌面宿主的影响。
> 结论：Aether v0.1.1 可作为公共底座；AutoNote 不需要推倒重来，需做依赖收口与边界内的复杂度削减。

## 1. 总结

Aether v0.1.1 的重构满足大部分工程最佳实践：职责分层、公共合同唯一来源、Rust/TypeScript 执行层分离、宿主授权边界、unknown/取消/审批语义和真实验收门禁均有明确设计。它不是无风险版本：UI 以 TS/Svelte 源码发布，`chat-attachments.svelte.ts` 的构造函数参数属性与严格 `erasableSyntaxOnly` 消费者不兼容；Rust 与 TypeScript 双执行层需要持续行为对照；Windows 证据强于 macOS/Linux。

AutoNote 当前边界正确：`note-core` 继续拥有 `library.db`，Aether 拥有 Provider/Chat/MCP/Skills 运行基础，产品角色、笔记上下文、Writing 安全写回和业务 MCP 工具由 AutoNote 保留。当前主要问题不是架构方向错误，而是：Aether 版本仍固定旧提交、Web AI 文件职责过重、Native 组合根过大、部分 Worker JSON 解码直接类型断言。

## 2. Aether 评审

### 2.1 优点

- `contracts`、`core`、`worker`、`ui`、Rust runtime 和 Tauri plugin 的依赖方向清晰。
- 公共 DTO、错误、状态事件和 Rust/TS 绑定有唯一来源。
- Providers/Search 与 Store 解耦；宿主可保留自己的身份、授权、存储和预算。
- Run/Conversation/Tool/MCP 的 owner、取消、审批、unknown、保存先于 End 等不变量明确。
- 重构按职责拆分大模块，而不是复制第二套协议实现。
- `docs/24` 的验收矩阵覆盖合同、Providers、Search、Chat、MCP、Skills、Images、UI 生命周期和平台接入。

### 2.2 已知缺口

1. npm `@ouraihub/aether-ui@0.1.1` 仍有 `erasableSyntaxOnly` 不兼容的构造函数参数属性；应在 Aether 发布 patch 修复，宿主临时补丁只能作为过渡。
2. Rust 和 TypeScript 双执行层存在长期行为漂移风险；场景合同和 loopback 行为门禁必须持续运行。
3. 发布仓库 CI 通过不等于每个外部宿主通过；源码包必须用严格 Node/Worker/Svelte/Tauri 消费者验证。
4. macOS/Linux 原生窗口、重启和平台密钥服务证据不能由 Windows 结果外推。

## 3. AutoNote 评审

### 3.1 保留的边界

- `library.db` 只由 `note-core` 访问；Aether 不打开领域数据库。
- AutoNote 保留 `chat`/`writing` 角色、`ModelRef` 绑定、`noteId` context、scope 和 Writing 安全写回。
- Web 自己的身份、CSRF、D1/R2、SSE、快照、资源授权和错误适配不替换为通用 Aether Worker adapter。
- MCP 工具通过 `note-core` 事务、CAS 和幂等执行，不绕过领域层。
- 不迁移旧 AI 表、密文、对话和 token；不增加兼容 shim。

### 3.2 优先优化

| 优先级 | 目标 | 现状 | 处理 |
| --- | --- | --- | --- |
| P0 | Aether 依赖收口 | Web、App、Desktop、Cargo 均固定 `53b806...` | 统一到 v0.1.1 发布提交并重建两套 lock |
| P1 | Provider 职责拆分 | `web/src/worker/ai/providers.ts` 约 892 行 | 按 schema、rows、keys、save、probe、resolve、routes 拆分，保留唯一入口 |
| P1 | Relay 安全边界拆分 | `relay.ts` 约 590 行，混合认证、协议、流和上游 | 按 auth/request/upstream/stream/routes 拆分，保持错误与脱敏语义 |
| P1 | Native 组合根拆分 | `desktop/src-tauri/src/lib.rs` 约 1000 行 | 保留组合根，提取 stores/runtime/shutdown/state |
| P2 | Skill runner 拆分 | `skill_runner.rs` 混合快照、进程、输出和取消 | 按 snapshot/validation/process/output 拆分，保持 revision 快照 |
| P2 | 图像协议复用评估 | `painting.ts` 自己处理协议和下载 | 只评估纯协议复用；地址、R2、审批、operation、unknown 仍归宿主 |
| P2 | 数据边界校验 | 多处 `JSON.parse(...) as Type` | 只在修改路径逐步增加运行时 schema 校验，不做全仓机械重写 |

## 4. 不做的优化

- 不整仓格式化或重写。
- 不把 AutoNote 业务下沉到 Aether。
- 不把 `library.db` 与 Aether 数据库合并。
- 不直接删除 `painting.ts`。
- 不关闭 strict、Svelte warning、Cargo clippy 或外部消费者检查。
- 不用兼容别名掩盖 Aether 合同冲突。

## 5. 证据与未验证项

已读取 Aether v0.1.1 发布说明、职责重构契约、验收清单、AutoNote Aether 迁移设计/任务清单及完整 AutoNote 主线。已对 Aether TS `RunEngine` 执行本地 loopback Chat SSE smoke：一次请求、`completed`、唯一 End 事件和 context token 19 均符合预期。

本评审没有修改代码，也没有将 AutoNote 的升级、跨平台 Native、真实供应商和远程部署写成已验证。升级后的所有受影响消费者必须重新验收。
