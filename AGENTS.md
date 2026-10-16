# AGENTS.md：给 AI 编码助手的硬性规则

详细工程规范见 `docs/04-工程规范.md`。本文件只列每次都必须遵守的几条。

## 1. 推送前必须通过 `pnpm run ci`

- `pnpm run ci` 依次运行 `web:check`、`web:test`、`web:build`、`desktop:verify`，和 `.github/workflows/web.yml`、`desktop.yml` 的检查步骤一致。
- 改了 `web/src/worker` 或 API，还要跑 e2e：先用 `AUTONOTE_EPHEMERAL_DEV=1 pnpm exec vite --port 7712 --strictPort` 起一个临时实例，再运行 `node web/scripts/e2e.mjs http://localhost:7712`。
- 只跑改动文件的测试（`vitest run xxx.test.ts`）不算验证。`pnpm run ci` 不通过，不提交、不推送、不汇报“已完成”。
- 新增 CI 步骤时，同时更新 `pnpm run ci` 和工作流，两边保持一致。

## 2. 共享代码在 Aether

- 聊天、模型服务、技能、MCP 的 UI 和 Rust 后端在 `../Aether`，那里有它自己的 `AGENTS.md`，推送前要跑通它的 `pnpm run ci`。
- 本仓库通过 commit 引用 Aether，共 4 处，必须同时修改：`web/package.json`、`desktop/package.json`、`packages/app/package.json`、`desktop/src-tauri/Cargo.toml`（`rev`），然后运行 `pnpm install`。
- 只能引用 CI 已经通过的 Aether commit。

## 3. 改契约时，全仓库找旧名字

契约包括：Aether DTO 和 ports、D1 schema 与迁移、HTTP 路由、Tauri 命令、i18n key、错误 reason。

- 改之前在 AutoNote **和** Aether 里搜索旧名字，范围包括 `web/tests`、`*.test.ts`、`fixtures`、`scripts`、`.tmp` 验收脚本、文档。
- 一次改完所有引用，不留别名或兼容字段。

## 4. 不许为了变绿而削弱检查

- 不删除、跳过或放宽测试，不加 `.skip`、`allow(...)`，也不删 lint 规则来让 CI 通过。测试过时，就按新行为改写，不能直接删掉。
- 不从 `pnpm run ci` 或 `.github/workflows/` 里删步骤。确实需要调整时，先说明理由并取得用户同意。
- `web/scripts/comment-allowlist.json` 只为确有必要的注释添加条目。不要为了消除报错整体重新生成。

## 5. 推送之后

- 到 GitHub Actions 看结果：`gh run list -R ouraihub/AutoNote -L 3`，需要先登录。失败就立刻修复。
- 不要部署到 Cloudflare，除非用户明确要求。
