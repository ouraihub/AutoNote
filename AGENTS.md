# AGENTS.md：给 AI 编码助手的硬性规则

详细工程规范见 `docs/04-工程规范.md`。本文件只列每次都必须遵守的几条。

## 1. 本地验证改动，GitHub 执行完整门禁

- 本地先跑受影响模块的类型/静态检查、相关测试套件，并实际运行改变的路径；不把只跑单个测试文件当作全部验收，不用完整 CI 反复调试。
- 完整门禁由 GitHub 执行：`release-kit.yml` 检查提交与注释；`web.yml` 执行 `web:check`、`web:test`、`web:build` 和 API e2e；`desktop.yml` 三平台各执行 `ci:desktop`（`desktop:verify`、`desktop:package:verify`），不重复 Web 检查。所有必需检查通过才允许合并。
- `pnpm run ci` 保留为需要时手动执行的完整本机入口，不再是提交/推送前的强制步骤；本地通过不能替代 GitHub 必需检查，远端失败不能汇报交付完成。
- 改了 `web/src/worker` 或 API，本地还要跑 e2e：在 `web/` 用 `AUTONOTE_EPHEMERAL_DEV=1 pnpm exec vite --port 7712 --strictPort` 起临时实例，再在根目录运行 `node web/scripts/e2e.mjs http://localhost:7712`。
- 新增 CI 检查时，同时更新对应脚本、完整 `ci` 入口和工作流，覆盖保持一致；共享应用检查由 Web job 执行一次，桌面平台检查仍逐平台执行。
- 推送或手动触发 GitHub Actions 前，先完成 `docs/04-工程规范.md` §13 本地 checklist，记录命令/平台/结果及未验证项。先用本机/WSL排错，禁止把三平台完整CI当逐次调试器；额度异常后未经用户同意不得再触发远端，也不得提高预算或削弱检查。

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

## 5. 改动走 PR，审查和合并都不需要人工

- main 受分支保护，不能直推。改动推到新分支，用 `gh pr create` 开 PR。
- PR 由 `ai-review.yml` 调用模型审查。审查通过、必需检查全绿后自动合并；发布 PR 也走同一流程，合并即发版。
- 审查要求修改时，按 PR 上的意见修改后推到同一分支，会重新审查。不要关掉审查、跳过检查，也不要用管理员权限合并。
- 分支名用 `<type>/<简述>`（type 同提交类型），一个分支只对应一个 PR。合并后 GitHub 自动删除远端分支；本地运行 `git switch main && git pull --prune` 并删除本地分支，不要在已合并的分支上继续提交。
- 到 GitHub Actions 看结果：`gh run list -R ouraihub/AutoNote -L 3`，需要先登录。失败就立刻修复。
- 不要部署到 Cloudflare，除非用户明确要求。

## 6. 提交信息和代码注释

提交和代码由 `release-kit check` 检查（`pnpm run ci` 第一步；每次推送和 PR 由 `release-kit.yml` 执行），不合规 CI 直接失败。规则全文见 [release-kit 规则](https://github.com/ouraihub/release-kit#规则)，要点：

- 格式 `<type>(<scope>): <中文摘要>`，一条提交只做一件事，标题不超过 72 个字符。`feat`/`fix`/`perf` 的标题会原样进入 CHANGELOG，写用户能看到的效果，例如 `fix(sync): 未绑定账号时禁用同步按钮`。
- 正文默认不写。只有 diff 看不出原因时，写 1–3 行"为什么"。不写文件列表、字段清单、`Verified:`/`验证：`、AI 署名，这些已经在 diff、CI 和 PR 里。
- 提交、代码注释、标识符里不写参考或对标项目名（禁用词在 `release-kit.json`）。来源只写进 `docs/` 设计文档。注释写行为和约束，不写"参考 xx 实现"。
- 同一个问题的多次修补，推送前合并成一条。

## 7. 版本和发布

- 不要手改版本号，也不要手动打 tag。版本号、`CHANGELOG.md` 和发布 PR 由 release-please 维护，合并发布 PR 就是发版。
- 合并后的提交只构建一次。Desktop 三个平台全部成功后，`release-kit tag` 自动打 `desktop-v<版本>`，`desktop-release.yml` 复用这次构建的包发布到 OurAIApps，不重新编译。流程见 `docs/42`。
