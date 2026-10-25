# desktop/scripts

构建、发布、清理和 Windows 编译环境都由 [`@ouraihub/desktop-kit`](https://github.com/ouraihub/desktop-kit) 提供（配置在 `desktop/package.json` 的 `desktopKit`）。日常只用 `pnpm run <命令>`（在 `desktop/` 下）：

| 命令 | 作用 |
| --- | --- |
| `dev:app` | `desktop-kit dev` |
| `build:app` | `desktop-kit build`：版本检查 → verify → 打包 → `dist/candidate-<平台>/`；Windows 还会更新 `dist/AutoNote/` 里的 exe |
| `test:rust` `clippy` `fmt:rust` | `desktop-kit cargo …` |
| `clean` | `desktop-kit clean`；加 `--deep` 连同全部 `node_modules` 一起删。始终保留所有 `data/`（笔记库）和 `web/.wrangler` |

Windows 首次使用，在仓库根运行 `node_modules\@ouraihub\desktop-kit\msvc\setup-msvc.bat` 下载便携 MSVC。

这里只剩 AutoNote 自己的检查：

| 文件 | 用途 |
| --- | --- |
| `package-verify.mjs` | CI：构建真实安装包，再在 macOS/Linux 启动冒烟 |
| `smoke-native.mjs` | macOS/Linux：启动安装包，检查数据库和截图 |
| `test-secrets.mjs` | 系统凭据存储真实读写（`verify` 的一部分） |
