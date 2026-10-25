# desktop/scripts

日常只用 `pnpm run <命令>`（在 `desktop/` 下），不直接调用这里的文件。Windows 编译环境由 `@ouraihub/msvc-kit` 提供（pnpm 装在仓库根 `node_modules`），首次使用在仓库根运行 `node_modules\@ouraihub\msvc-kit\setup-msvc.bat`。

| 命令 | 入口 |
| --- | --- |
| `dev:app` | `app.mjs dev` → `dev.bat`（Windows） |
| `build:app` | `app.mjs build` → `build-app.bat`（Windows）→ `build/release-build.mjs` |
| `check:rust` `test:rust` `clippy` `fmt:rust` | `cargo.mjs`（Windows 经 msvc-kit 的 `cargo-msvc.bat`） |
| `package:verify` | `build/package-verify.mjs` |
| `test:release` `test:secrets` | `test/` |
| `clean` | 清理编译产物；加 `--deep` 连同全仓库 `node_modules` 一起删（之后 `pnpm install` 恢复）。仓库根也能运行 `pnpm run clean --deep`。始终保留 `dist/AutoNote/data`、`target/*/data` 里的笔记库，以及 `web/.wrangler` 和 Cloudflare 登录。Windows 走 `tools/clean.bat`，其他平台走 `cargo clean` |

## 入口（根目录）

| 文件 | 用途 |
| --- | --- |
| `app.mjs` | `dev` / `build` / `clean` 按平台分发 |
| `cargo.mjs` | 运行 cargo，Windows 先注入 MSVC |
| `build-app.bat` | Windows 发布构建：注入 MSVC，再调 `build/release-build.mjs` |
| `dev.bat` | Windows `tauri dev`：注入 MSVC |

## build/ 构建与发布

| 文件 | 用途 |
| --- | --- |
| `release-build.mjs` | 发布构建总流程：版本检查 → verify → `tauri build` → 收集产物 |
| `release-artifacts.mjs` | Windows：收集 NSIS 和便携 zip，写 `dist/release.json`；其他脚本共用的 `root`、`sha256`、`noLinks` |
| `release-candidates.mjs` | 三平台候选包清单：生成、校验、汇总 |
| `publish-release.mjs` | `desktop-release.yml` 用：核对候选包后发布到 GitHub Release |
| `version-check.mjs` | `package.json` 与 Cargo 版本一致、tag 匹配 |
| `native-icon.mjs` | macOS：由 `icon.png` 生成 `icon.icns` |
| `package-verify.mjs` | CI：构建真实安装包后启动冒烟 |
| `smoke-native.mjs` | macOS/Linux：启动安装包，检查库和截图 |

## test/ 自动测试（由 `verify` 运行）

| 文件 | 用途 |
| --- | --- |
| `release-artifacts.test.mjs` | 发布 CLI 参数、缺包失败、不碰用户数据 |
| `release-candidates.test.mjs` | 候选包清单校验 |
| `release-gate.test.mjs` | Windows：本地缺便携 MSVC 必须失败；运行 `release-safety.test.ps1` |
| `release-safety.test.ps1` | 清理不碰任何 `data`、junction 和 `web/.wrangler`，`--deep` 删光 node_modules |
| `test-secrets.mjs` | 系统凭据存储真实读写 |

## tools/ 手动工具

| 文件 | 用途 |
| --- | --- |
| `clean.bat` | 清理构建产物，保护所有 `data` 目录和 junction；`--deep` `--kill` `--yes` |
| `clean-artifacts.ps1` | `clean.bat` 的白名单删除实现 |

`.bat` 必须保持 CRLF 和纯 ASCII。
