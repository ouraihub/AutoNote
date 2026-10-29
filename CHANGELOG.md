# Changelog

## Unreleased

### 新功能

* **ai:** 技能“添加技能”菜单支持通过 Agent 创建（内置 skill-creator 多轮创作，脚本逐次审批运行，预览确认后安装）、在线搜索／GitHub URL、系统搜索和本地导入。

### 问题修复

* **ai:** Web 运行快照只按结束时间保留最近 200 个终态，运行中的快照不会被裁剪，避免历史运行较多时状态查询和取消返回 404。

### 内部调整

* 根目录、Web、桌面与 GitHub Actions 统一使用最新 Node LTS `26.13.0`（Lithium）和 pnpm 正式版 `12.16.1`；Node 由 `.node-version` 固定并供 CI 读取，`devEngines.runtime` 让 pnpm 自动下载并用于项目脚本，pnpm 由 `packageManager` 固定。
* 桌面 Tauri API／CLI 更新到正式版 `2.12.4`，匹配现有 Rust 锁文件的 Tauri 2.12，修复打包版本门禁失败。
* 桌面 AI 端口改用行为回归验证会话错误、权限拒绝、技能源取消和本地图像边界；Web 探测保留手动重定向安全断言。

* Aether 前后端统一固定 Git 提交 `53b80630bdd58f22ca94d119e93586f84fbceec7`，恢复 Git 子包解析与来源检查；原补丁已并入上游。桌面拆分运行／会话／MCP runtime，Web 复用 core 执行并保留产品存储与授权；验收见设计文档 24 §15。

## [0.2.10](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.9...desktop-v0.2.10) (2026-10-29)


### 问题修复

* **editor:** 中文输入标题时不再回退或意外跳转正文 ([fb4bc9d](https://github.com/ouraihub/AutoNote/commit/fb4bc9d0cc8f3fd3b706aaf68651e057b7b610dd))
* **editor:** 中文输入标题时不再回退或意外跳转正文 ([ddceda6](https://github.com/ouraihub/AutoNote/commit/ddceda646b0bc7e5a0e47f6748eaeb0c8a166ca1))

## [0.2.9](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.8...desktop-v0.2.9) (2026-10-29)


### 新功能

* **ai:** 技能可通过 Agent 创建、在线搜索或扫描本机导入 ([5cb8904](https://github.com/ouraihub/AutoNote/commit/5cb8904facabef255405e5fe2600102dba6a2af6))
* **ai:** 迁移到 Aether 主干并支持多种方式添加技能 ([687fcdc](https://github.com/ouraihub/AutoNote/commit/687fcdc7fd74b526652fb229734d5b33aad64545))


### 问题修复

* **ai:** Web 取消可跨 Worker 实例生效 ([9191e72](https://github.com/ouraihub/AutoNote/commit/9191e727b555d5952ded72edbbaa8aa02adc2676))
* **ai:** Web 取消运行先由服务端中止并返回终态 ([d7b1b18](https://github.com/ouraihub/AutoNote/commit/d7b1b186aae089bbd98eb3ea57cf575560d4d937))
* **ai:** 保留运行中快照并改用 Aether npm 包 ([6158a15](https://github.com/ouraihub/AutoNote/commit/6158a15cdeeedf0ce5ef17361aa00d79afc050b6))
* **integration:** 恢复统一 Git 依赖与安全回归 ([8d7e768](https://github.com/ouraihub/AutoNote/commit/8d7e76803dbff61e7b84234a169eb4a0daf24120))

## [0.2.8](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.7...desktop-v0.2.8) (2026-10-28)


### 新功能

* **desktop:** 接入技能脚本、MCP 客户端及权限模式 ([86602bf](https://github.com/ouraihub/AutoNote/commit/86602bf429a32bdfb74f20ebd5c9f4609f8bf632))
* **desktop:** 接入技能脚本与 MCP 客户端及权限模式 ([e62c638](https://github.com/ouraihub/AutoNote/commit/e62c638e076edc97c57130043e11e3ac39e741f7))


### 问题修复

* **desktop:** 技能脚本不得放宽既有权限拒绝 ([a29b7e8](https://github.com/ouraihub/AutoNote/commit/a29b7e8dd338e89c6bb32c1ab9885a7f775863fe))

## [0.2.7](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.6...desktop-v0.2.7) (2026-10-26)


### 新功能

* **relay:** GitHub 临时密钥 6 小时有效，并发超限提示重试 ([653619a](https://github.com/ouraihub/AutoNote/commit/653619a6a0be3076073c3239ac9bb164deb85eaf))
* **relay:** GitHub 临时密钥有效 6 小时，并发超限时提示稍后重试 ([02d9829](https://github.com/ouraihub/AutoNote/commit/02d9829edd0fbd63531cbe238cd0e0268a0212c8))

## [0.2.6](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.5...desktop-v0.2.6) (2026-10-25)


### 新功能

* **ai:** 检测时识别中转支持 Anthropic 协议并建议切换 ([a925997](https://github.com/ouraihub/AutoNote/commit/a925997834113ad0dfb68a2128d37c0e54077c16))

## [0.2.5](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.4...desktop-v0.2.5) (2026-10-24)


### 问题修复

* **preview:** Mermaid 节点文字不显示 ([ccb295d](https://github.com/ouraihub/AutoNote/commit/ccb295debab10240aa24cbc9054d137ecfa39ef2))

## [0.2.4](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.3...desktop-v0.2.4) (2026-10-24)


### 新功能

* **ai:** 模型转发与工作流临时凭据及设置 ([df279bd](https://github.com/ouraihub/AutoNote/commit/df279bdb393b1b67c4046b7671d421335014c465))
* **ai:** 模型转发支持图片生成与参考图编辑 ([ac55455](https://github.com/ouraihub/AutoNote/commit/ac55455157d3dbfe1c6fdcd72fb7160de1672c4a))
* **ai:** 模型转发支持访问密钥、工作流临时凭据与独立设置 ([58fa28b](https://github.com/ouraihub/AutoNote/commit/58fa28bddc40d708eff2c82c98a2cd9e7571d750))
* **ai:** 线路可选“用完再换”，用完的密钥自动跳过 ([a3255be](https://github.com/ouraihub/AutoNote/commit/a3255be6da8fbe3efa342ca833fbc93ac2bcf1d6))
* **ai:** 线路支持用完再换，暂停密钥并保留聊天与绘图重试 ([76133ee](https://github.com/ouraihub/AutoNote/commit/76133ee93a67c2c28625c96fc7d56432a7ced1f5))


### 问题修复

* **ai:** 最后一个密钥暂停时立即返回恢复时间 ([cc5846a](https://github.com/ouraihub/AutoNote/commit/cc5846a14be6117fabcd6104651b3d58a101f671))
* **ai:** 绘图线路暂停时保留恢复时间与线路名 ([daf146f](https://github.com/ouraihub/AutoNote/commit/daf146fe0ee64e5319ae3462f50a89306498ff53))
* **ai:** 重复密钥按实际记录暂停避免持续重试 ([990ad84](https://github.com/ouraihub/AutoNote/commit/990ad84291e464c24b2cc497dcdf57314501bca0))
* **ci:** 一致性审查读取全部原始补丁 ([ba0be88](https://github.com/ouraihub/AutoNote/commit/ba0be88f8d654220a458029d13d00cae0b50fd12))
* **ci:** 分批审查增加跨文件一致性检查 ([aa60ad1](https://github.com/ouraihub/AutoNote/commit/aa60ad187499a491cb3685606fc4eadf9816046f))
* **ci:** 大型改动按完整文件分批审查 ([a704c29](https://github.com/ouraihub/AutoNote/commit/a704c2952b7446a4a98e2bf06eeebeefadf4e8d7))

## [0.2.3](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.2...desktop-v0.2.3) (2026-10-23)


### 新功能

* **sync:** 桌面同步按笔记 id 合并绑定，解绑后本地数据保留并重新上传 ([7b4768e](https://github.com/ouraihub/AutoNote/commit/7b4768e9fe560c8faa1916d094893a066ab83bb0))


### 问题修复

* **desktop:** 账号菜单按同步状态显示登录同步或解除同步绑定 ([62d4e81](https://github.com/ouraihub/AutoNote/commit/62d4e8185795789e5c726c19bd70b133f640c50c))

## [0.2.2](https://github.com/ouraihub/AutoNote/compare/desktop-v0.2.1...desktop-v0.2.2) (2026-10-22)


### 新功能

* **ai:** 中转线路也能选思考档位，切换模型和重启后保留所选档位 ([089384b](https://github.com/ouraihub/AutoNote/commit/089384b75e08f6fa39ddaf44f530857c96dd7136))
