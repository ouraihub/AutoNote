# 40 macOS 与 Linux 桌面版设计及开发规划

## 1. 范围和发布合同

本轮实现 macOS Apple Silicon（aarch64）的 DMG、Linux x64 的 AppImage/DEB，保留 Windows x64 NSIS/portable ZIP。Intel Mac、Linux ARM 不在本轮范围。源码仍在私有 ouraihub/AutoNote，所有通过检查的安装包发布到公开 OurAIApps/AutoNote。发布条件沿用用户决定：原生编译、自动检查、版本/包内容/哈希校验通过，不要求独立真人审核或 VM 证明；不得将这些检查描述为完整人工验收。

当前 0.1.0 保留不覆盖，新跨平台版本使用 0.2.0。下载资产固定名称：AutoNote-windows-setup.exe、AutoNote-windows-portable.zip、AutoNote-macos-arm64.dmg、AutoNote-linux-x64.AppImage、AutoNote-linux-x64.deb。所有平台候选成功后一次发布，避免 latest 只含部分平台。

## 2. 已核对的根因

- AutoNote 同步凭据 `shell/src/credentials.rs` 只实现 Windows DPAPI，其他平台返回 StorageUnavailable。
- Aether `aether-support::secret` 同样只实现 DPAPI；仅修 AutoNote 会遗漏模型 API Key 和网络搜索凭据。
- 运行时目录固定在可执行文件旁，不适用于 macOS 签名应用包、Linux /usr/bin 或 AppImage 只读挂载。
- 打开日志目录仅实现 explorer.exe；check/test/clippy/fmt 和 build:app 脚本依赖 Windows bat。
- 发布 manifest 强制恰好 NSIS+ZIP，workflow 仅 windows-latest；Web 下载页只有 Windows。

## 3. 凭据与平台边界

Aether 统一提供平台安全存储能力。Windows 保持原 DPAPI BLOB 格式可读，不迁移用户数据；macOS 使用 Keychain、Linux 使用会话 Secret Service 保存随机主密钥，以成熟 AEAD 实现加密数据库 BLOB，每次加密使用随机 nonce。主密钥不可写入数据库、日志或普通文件；Secret Service 缺失/锁定时返回明确配置/存储错误，不回落明文或临时密钥。不在启动时强制访问 keyring，离线笔记在无 keyring 情况下仍可使用。

主密钥初始化使用原生文件锁串行化：锁文件只存锁元数据，不存密钥；身份按规范化绝对 HOME 的 SHA256 区分，避免隔离 CI HOME 与正常账号互相覆盖。系统密钥环存储不可用时不创建替代密钥。单次 BLOB 格式含平台 marker、随机 nonce 和 AEAD 密文/标签；读取验证长度及标签，跨平台迁移库后需要重新输入凭据，不伪称 Windows DPAPI 可跨平台解密。

AutoNote 同步复用 Aether 的非 Windows 凭据实现（现有 SecretStore 字节接口，内部编码可用 base64），Windows 的既有 Cookie DPAPI 格式保持不变。外部 DTO、HTTP/IPC 契约不变。框架新依赖固定版本，仅在相应目标平台编译。系统 Keychain/Secret Service 集成在原生 CI 的真实服务会话内验证加密、解密、重启、篡改拒绝；纯单元测试不依赖开发者凭据。

## 4. 运行数据与桌面操作

- Windows：继续 exe 同级 data，已有便携目录不变。
- macOS：$HOME/Library/Application Support/com.autonote.desktop。
- Linux：绝对 XDG_DATA_HOME/com.autonote.desktop；未指定时 $HOME/.local/share/com.autonote.desktop。缺少可靠用户目录时启动失败，不回退 cwd/TEMP。
- SQLite、附件、日志、同步配置和界面状态继续使用同一个解析后的根目录。macOS WebKit 不调用仅适用于 Windows/Linux 的 data_directory 方法；系统 WebView 缓存按平台能力处理，不声称全部跟随便携库。
- 打开日志目录采用现有 Tauri opener 插件或系统 open/xdg-open；不可在非 Windows 静默成功但不操作。
- 系统快捷键、托盘、文件选择和自定义附件协议在原生 runner 检查；无托盘环境保持已有禁止不可达隐藏的策略。

## 5. 构建发布

沿用 pnpm 和 Rust 1.92.0，不换 UI 框架，不增加第二套应用。Node 平台分发脚本在 Windows 调用现有 MSVC wrapper、其他平台直接 cargo --manifest-path。原生 CI 使用 macOS ARM64、Ubuntu x64、Windows x64；安装 WebKitGTK/GTK/AppIndicator/OpenSSL/打包依赖。desktop:verify 包含 Clippy（`--all-targets`，覆盖 `check --workspace --all-targets`）、完整现有测试、fmt、发布边界与原生凭据冒烟，检查不删减。根 pnpm run ci 同步包含 desktop:package:verify，构建真实安装包；非 Windows 再检查格式/内嵌版本/架构、真实窗口、隔离 HOME 中 library.db schema/quick_check 与截图，结束删除隔离数据。该启动冒烟不等于人工验收全部交互。

保留 Windows 现有构建收集，给非 Windows 增加明确的平台 manifest，校验版本、包种类、非空正规文件、路径包含、SHA256，不上传数据/密钥/日志。`desktop.yml` 统一执行三平台质量门与打包冒烟，成功后上传三个候选 artifact（非 PR，保留30天）；`desktop-release.yml` 仅下载、核验并发布，不再编译。先等待 main 目标提交的 Desktop 成功，再打 `desktop-v<version>` tag；发行自动选择相同提交最近成功的 Desktop run，也支持手动指定 `build_run_id`（workflow ref 必须为所选 tag）。必须同时满足 main 来源、完成且成功、三项原生任务成功、同一提交/run、版本及五包哈希；候选缺失或过期直接失败，需明确运行 Desktop，不能静默回退重编。使用现有 RELEASE_TOKEN 创建公开 Release；公开仓库不复制私有 Git 对象、构建日志或自动生成私有 commit 说明。

macOS 使用 ad-hoc 签名，不具备 Developer ID 签名、未公证，可能受 Gatekeeper 限制。以后配置 Apple 凭据才可宣称 Developer ID 签名或公证。Linux 说明支持的发行版基线和 Secret Service 依赖，不宣称任意发行版通用。公开资产仅含五类安装包，发布说明列出 SHA256，不上传截图、日志、凭据或运行数据。

## 6. 执行任务与验收

1. 框架凭据实现、文档、平台原生 CI；Aether pnpm run ci 通过并推送后才更新 AutoNote 四处 commit 引用及 lockfile。
2. AutoNote 同步凭据复用、运行目录、打开日志目录；行为回归覆盖默认路径/非法环境、字节凭据和 Windows 兼容。
3. 跨平台脚本、Tauri 平台配置、图标、平台 manifest、CI/release matrix；构建真实 DMG/AppImage/DEB，不以 cargo check 代替打包。
4. 下载页新增 macOS/Linux 链接与系统数据位置/签名说明，中英同步；真实浏览器验证窄屏和匿名下载。
5. 本地 pnpm run ci；原生 macOS/Linux 构建检查及真实小程序/应用启动冒烟；下载公开资产并对比候选 SHA256。记录实际限制，禁止 stub/no-op。

## 7. 证据记录

2026-10-20：本地真实 Chromium 打开 /download，中英两种语言 × light/dark × 320/375/414/768px，共16组合无横向溢出；五个下载入口均指向 OurAIApps/AutoNote 的固定资产名，实际截图核对中文/英文窄屏布局。此时公开 latest 仍为0.1.0，macOS/Linux 链接的匿名下载及包哈希待0.2.0发布后验证。原生构建/安装/完整人工交互尚未通过，不提前勾选。

- Web 完整质量门 `pnpm run web:check && pnpm run web:test && pnpm run web:build` 已通过：共享11项、Web196项、脚本8项；Svelte/TypeScript检查0错误0警告。Vite仍提示已有配置导入扩展名及大chunk警告，未关闭检查。
- `pnpm --filter autonote-desktop test:release` 已通过既有发布边界与新增五包聚合校验，覆盖版本/提交/run不匹配、缺包/重复包、路径逃逸、错误哈希、空包、额外私有文件及符号链接拒绝。完整根CI和真实原生包验证仍待后续记录。
- Aether 本地 `pnpm run ci` 已通过（UI143项及整个Rust workspace、fmt、Clippy、各插件feature）；已推送提交 `8481f541ca4e57c48797510e26430bc0712baa4b`，GitHub原生三平台运行 `39362137697`。宿主引用等待该运行绿色后统一更新，未把Windows本地通过当作Unix原生通过。
- Aether运行 `39362137697`：Windows通过，Linux/macOS在DTO检查编译Tauri示例时失败；日志分别指向mcp-server-only/providers-only的缺失 `icons/icon.png`。三个示例此前仅声明ICO。修复为共用现有ICO及从同一图标导出的32×32 RGBA PNG，未减少workspace检查；后续原生重跑结果另记。
- 图标修复已通过本地完整Aether `pnpm run ci`（artifact3423），三个配置均实际解析到32位RGBA PNG；已推送 `d0562c8008c7dc75189bb9a32d3f1baf6e0ceb4e`，原生重跑 `39363128183`。尚未将新运行记作通过。
- 原生重跑 `39363128183`：两平台DTO均报告 `68 generated files match`，完整Rust检查与测试已越过；最后凭据冒烟启动因脚本漏写Cargo示例目录 `debug/examples/` 而ENOENT。已同步修正脚本与README所有命令；这不是DTO再次失败。
- 路径修复 `fda0176bada58c1a2f0a19febf14275a45bf34a4` 本地完整CI通过（artifact3432），真实编译的 `target/debug/examples/native-secrets.exe` 独立seal/open/forget读回通过；原生重跑 `39364089493`。额外在Windows直接运行Unix专用逐字节tamper冒烟时失败，不能将该Unix验证宣称为Windows通过；Windows仍执行现有DPAPI契约检查。
- 运行 `39364089493`：Windows、Linux完整CI通过；macOS最后race返回 `secret_store_unavailable`。Keyring后端使用用户域默认Keychain，冒烟却只改子进程HOME而保留另一HOME配置的钥匙串偏好。修复测试隔离方式：macOS保留真实HOME，切换空的临时默认Keychain并在结束恢复；Linux继续隔离HOME。未修改生产密钥权限、未跳过并发首次创建检查，原生验证结果待新运行。
- Aether最终提交 `bfab60980e7fc9f1227f9cb686587d96fbc19cb1` 的GitHub运行 `39365237126` 全绿：Windows4m59s、Linux4m20s、macOS7m45s。三平台完整CI通过，macOS临时Keychain首次并发创建/跨进程读回/篡改拒绝已真实执行通过。
- AutoNote四处Aether引用已统一至三平台绿色 `bfab6098`，pnpm/Cargo锁文件已更新。本机完整 `pnpm run ci` 通过（artifact3455），含Windows真实NSIS/portable打包与凭据独立进程seal/open/tamper/forget。buildId `0.2.0-4540e9b2-743d-4762-8e96-87839b094445`，exe SHA256 `73a99aa2d62c631e5132c0b6d22ffaee3944eadaeeb47e9c9d305f4356c13102`。
- Windows打包exe经UIA实窗验收：设置→关于实际显示0.2.0、库目录为exe旁data，点击打开日志目录后枚举到真实Explorer目标窗口；PrintWindow截图核对，关闭正常退出0。临时脚本按UTF8读取，未访问用户生产库。macOS/Linux宿主包仍待原生runner构建与启动冒烟。
- 宿主原生运行 `39367556615` 的macOS编译报告 `icons/icon.png is not RGBA`。四个现有PNG实际都是8位RGB（color type2）；已统一无损转成8位RGBA（type6），逐像素ARGB比较全部不变，尺寸仍32/128/256/512，未换图、未绕过Tauri检查。完整本地与原生重跑待后续结果。
- RGBA修复提交 `e4fca18` 已通过完整本地CI（artifact3467）。原生重跑 `39369828351` 已越过图标编译：macOS完整desktop:verify通过、真实DMG已构建，窗口冒烟Swift缺Foundation桥接导入；Linux导出五个行为测试失败，发布后目录同步使用cap-std的路径句柄且清理不存在partial掩盖原错误。修复窗口脚本导入Foundation；目录同步改为同能力目录下打开可读`.`句柄，清理只忽略已经不存在的临时文件，保留真实同步错误。
- 修复提交 `8aa7e29` 的原生运行 `39373959227`：macOS任务 `118467792907` 已成功，真实DMG格式/版本/ARM64/ad-hoc签名检查、挂载启动、可见窗口、隔离HOME库schema/quick_check与PNG截图通过；Linux/Windows当时仍执行中。另WSL Linux transfer回归12项全通过，本机完整CI通过（artifact3483）。
- 同轮Linux已通过完整测试并真实构建83.49MiB AppImage、8.80MiB DEB；DEB启动后窗口/库均可见，但截图检查过早且以压缩文件1KB阈值误判。改为按启动PID定位窗口、显式PNG、等待至少960×640且超过16种颜色的真实帧，仍验证PNG签名；不以文件压缩大小判断是否渲染。
- 运行 `39377448932`：Windows、macOS均全绿；Linux DEB真实窗口/隔离库/完整尺寸渲染截图通过，随后旧的AppImage/DEB二进制全SHA相等检查失败。Tauri官方bundler会分别写入 `__TAURI_BUNDLE_TYPE_VAR_APP/DEB`（两包全文件哈希不应相同）。改查两个ELF的x64架构、相同GNU build-id及各自包格式标记，外层各包仍使用独立SHA256验证，再真实启动AppImage。
- 原生运行 `39381629797`：Windows/macOS全绿；Linux日志明确DEB与AppImage均 `PASS`（真实窗口、隔离库、PNG实帧），仅最外层清理因D-Bus会话结束后的portal FUSE挂载点 `Transport endpoint is not connected` 失败。改为保留shell EXIT trap，在D-Bus结束前通过portal依赖的fusermount3卸载doc挂载，随后仍完整删除隔离目录；不吞清理错误。
- 最终宿主提交 `8896801edadaf5af1db6793b865ce9587f4b7183` 的Desktop运行 `39386284846` 三平台全绿：Linux20m46s、macOS13m4s、Windows25m55s。Linux包含DEB/AppImage真实启动、实帧截图及portal卸载/隔离目录清理，未跳过质量门。
- 正式tag `desktop-v0.2.0` 的发行运行 `39389252446` 三个Build任务全部成功并上传候选；publish任务因GitHub账号账单/额度被平台拒绝启动。使用本机既有授权下载同轮候选，通过版本/提交/run/五包集合/大小/SHA256及三项Build成功校验后发布到公开 `https://github.com/OurAIApps/AutoNote/releases/tag/desktop-v0.2.0`。未改tag、未混用本地重编包，工作流总状态仍因账单限制失败，不能记作发行工作流全绿。
- 已不带Authorization/Cookie匿名下载五个latest链接：全部HTTP200，下载字节数和SHA256逐一等于正式候选。Windows安装包6696613B、ZIP7732201B、macOS DMG10800716B、AppImage87542264B、DEB9224212B。SHA256完整值见公开发行说明。0.1.0未覆盖，未部署Cloudflare；macOS为ad-hoc签名，未Developer ID签名/公证，未声称完整人工安装卸载生命周期通过。
- 2026-10-20 按用户要求取消发行二次编译：将候选上传移至 Desktop，Release 仅复用成功运行；移除同轮运行未完成时的发布豁免。旧 Desktop 运行未上传候选，不能追溯复用，需新流程首轮成功后才能发行；已发布0.2.0不受影响。本轮未推送、未触发或重跑GitHub Actions。
- 为保持原发行质量门不减，Desktop 三平台直接运行根 `pnpm run ci`（包含原有 Web、desktop:verify 与 desktop:package:verify）；不是删除发行检查，而是将其集中到唯一构建入口，Release 不再重复执行。根CI命令未变。
- 新流程本地验证：完整根 `pnpm run ci` 成功（artifact3558），包含Windows真实NSIS/portable构建；actionlint1.7.12验证两个工作流通过，发行回归及格式检查通过。只读GitHub API按真实0.2.0提交选中旧Desktop运行39386284846；旧运行缺新候选任务合同被明确拒绝。真实五包候选重新聚合、大小/哈希全部通过；实际运行publish-release入口时，旧提交候选被来源校验阻断，未调用公开发布。新工作流的远端artifact上传/下载尚未执行，未宣称三平台新流程通过。
