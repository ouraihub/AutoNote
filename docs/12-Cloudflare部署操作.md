# 12 Cloudflare 部署操作

Web 版部署为一个 Cloudflare Worker（`autonote`），同时托管前端静态资源和 `/api`，正式地址 `https://autonote.ouraihub.com`。提供两种部署方式，最终都执行同一个入口 `web/scripts/deploy.mjs`：

- **方式 A：AI Agent 部署**：在本机让 AI 编程助手（Claude Code、Kiro、Cursor 等）按第 3 节的提示词执行，适合首次部署和临时发版。
- **方式 B：GitHub Actions 部署**：`.github/workflows/web.yml` 已写好，在 GitHub 网页上点按钮发版，适合日常发布。

两种方式部署的是同一个 Worker、同一套数据，可以混用。

## 1. 需要你提供的东西

| 项 | 用途 | 方式 A（AI Agent） | 方式 B（GitHub） |
| --- | --- | --- | --- |
| Cloudflare 账号 | 承载 Worker 和资源 | 必需 | 必需 |
| 在账号里开通 R2 | 附件存储（默认模式） | 必需 | 必需 |
| `ouraihub.com` 在该账号下 | 自定义域名 | 必需 | 必需 |
| Account ID | 指定部署到哪个账号 | 用 `wrangler login` 时不需要 | Secret `CLOUDFLARE_ACCOUNT_ID` |
| API Token | 部署权限 | 用 `wrangler login` 时不需要 | Secret `CLOUDFLARE_API_TOKEN` |
| 本机环境 | 运行构建 | Node LTS 26.13.0、pnpm 12.16.1、仓库代码 | 不需要 |

Worker 本身不需要任何 secret：数据库表由 Worker 启动时自建（`web/src/worker/db/schema.ts`），凭据加密密钥存在 `CREDENTIAL_VAULT` Durable Object 里。

### 1.1 获取 Account ID

Cloudflare 控制台 → 左侧 **Workers 和 Pages** → 右侧栏 **账户 ID**，复制即可。

### 1.2 开通 R2

控制台 → **R2 对象存储** → 按提示启用。R2 有免费额度，但启用时 Cloudflare 要求绑定支付方式。

不想开通 R2 就改用 KV 模式（附件存 KV），见第 5 节。**首次部署前就要选定**，之后切换模式不会迁移已有附件。

### 1.3 创建 API Token

控制台 → 右上角头像 → **我的个人资料** → **API 令牌** → **创建令牌** → **创建自定义令牌**，权限如下：

| 范围 | 权限 | 级别 |
| --- | --- | --- |
| 账户 | Workers 脚本 | 编辑 |
| 账户 | Workers KV 存储 | 编辑 |
| 账户 | Workers R2 存储 | 编辑 |
| 账户 | D1 | 编辑 |
| 账户 | Workers AI | 读取 |
| 账户 | 账户设置 | 读取 |
| 用户 | 用户详细信息 | 读取 |
| 区域 | Workers 路由 | 编辑 |
| 区域 | DNS | 编辑 |

“账户资源”选你的账号，“区域资源”选 `ouraihub.com`（两条区域权限用于自动绑定 `autonote.ouraihub.com`）。Token 只显示一次，立刻保存，不要提交到仓库。

## 2. 首次部署会创建什么

`web/wrangler.toml` 里的资源没有写 ID，`wrangler deploy` 第一次会自动创建，之后的部署会沿用：

| 绑定 | 资源 | 名称 |
| --- | --- | --- |
| `DB` | D1 数据库 | `autonote-db` |
| `FILES` | R2 桶 | `autonote-files` |
| `OAUTH_KV` | KV 命名空间 | 由 wrangler 按 Worker 名生成 |
| `SYNC_HUB`、`CREDENTIAL_VAULT` | Durable Object（SQLite） | 随 Worker 创建 |
| `AI` | Workers AI | 无需创建 |
| `triggers.crons` | 定时任务 | 每小时整点；每小时 15、45 分 |

不需要手动执行 D1 迁移。

## 3. 方式 A：AI Agent 部署

由你本机的 AI 编程助手执行命令。**凭据由你自己配置，不要把 Token 发到对话里**：对话内容可能被记录或上传到模型服务。

### 3.1 准备（你自己做，一次即可）

1. 本机安装 Node LTS（精确版本见根 `.node-version`）和 pnpm（精确版本见根 `package.json` 的 `packageManager`），克隆仓库；`pnpm install` 会按 `devEngines.runtime` 下载项目固定 Node，桌面与 Web 脚本使用相同运行时。
2. 在**你自己的终端**登录 Cloudflare，二选一：

   ```bash
   # 推荐：浏览器授权，凭据保存在本机用户目录，Agent 的命令会自动沿用
   pnpm --filter autonote-web exec wrangler login
   ```

   或者用 1.3 节的 Token：把 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 设为**用户级环境变量**（Windows：系统设置 → 环境变量；macOS/Linux：写入 `~/.zshrc` 等），然后重启 AI 助手让它读到。

3. 确认登录成功：

   ```bash
   pnpm --filter autonote-web exec wrangler whoami
   ```

### 3.2 交给 Agent 的提示词

在仓库根目录打开 AI 助手，复制下面整段发送：

```text
请按 docs/12-Cloudflare部署操作.md 把 AutoNote Web 版部署到 Cloudflare。严格按顺序执行，每步报告命令和结果：

1. 在仓库根目录运行 `pnpm install --frozen-lockfile`。
2. 运行 `pnpm --filter autonote-web exec wrangler whoami`，确认已登录并报告账号名。未登录就停下，提醒我按文档 3.1 登录，不要自己处理凭据。
3. 运行 `pnpm --filter autonote-web run deploy:check` 试跑，报告 Total Upload 和绑定列表。失败就停下，对照文档第 9 节说明原因。
4. 停下来等我明确回复“确认部署”，再继续。
5. 运行 `pnpm --filter autonote-web run deploy`，报告部署地址。
6. 等 1 分钟后运行 `curl -s https://autonote.ouraihub.com/api/health`，报告结果；证书未就绪就每分钟重试，最多 10 次。
7. 提醒我立刻打开 https://autonote.ouraihub.com 注册所有者账号。

限制：
- 不要读取、打印或保存任何 Token、API Key、`.env` 内容。
- 不要修改 web/wrangler*.toml、.github/workflows 和业务代码；需要改时先说明原因，等我同意。
- 不要执行任何删除操作（wrangler d1/r2/kv delete、wrangler delete 等），不要回滚。
- 不要 git commit 或 push。
```

Agent 第 3 步试跑只打包不上传；第 5 步才真正发布，所以第 4 步一定要等你确认。

## 4. 方式 B：GitHub Actions 部署

工作流 `.github/workflows/web.yml` 已经包含 `check` → `e2e` → `deploy` 三个 job。`deploy` 只在**手动触发、勾选 deploy、且分支是 `main`** 时运行。

1. 仓库 → **Settings** → **Environments** → 新建 `production`（工作流的 deploy job 使用这个环境）。可选：开启 **Required reviewers**，每次部署前要人工批准。
2. 在 `production` 环境下添加两个 **Environment secrets**：
   - `CLOUDFLARE_API_TOKEN`：1.3 节的 Token
   - `CLOUDFLARE_ACCOUNT_ID`：1.1 节的 Account ID
3. 把要发布的代码合并到 `main`。其他分支上手动运行工作流，`deploy` job 会被跳过。
4. 仓库 → **Actions** → **Web** → **Run workflow** → 分支选 `main` → 勾选 **Deploy to Cloudflare after checks pass** → **Run workflow**。
5. 等 `check`、`e2e` 通过后 `deploy` 自动运行，日志末尾有访问地址。

想改成每次推送 `main` 自动部署，把 deploy job 的 `if` 改成：

```yaml
if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
```

## 5. KV 模式（不开通 R2）

附件改存 KV，其余与默认模式相同。

- AI Agent：在提示词里把 `deploy:check`、`deploy` 换成 `deploy:check:kv`、`deploy:kv`。
- GitHub Actions：把 `web.yml` deploy job 最后一步的 `pnpm run deploy` 改成 `pnpm run deploy:kv`。
- Token 可以去掉“Workers R2 存储”权限。

两种模式部署的是同一个 Worker 名 `autonote`，不要来回切换。

## 6. 部署后必须做的事

1. **立刻注册所有者账号。** 第一个注册的用户成为 owner（`web/src/worker/routes/auth.ts`）；在你注册之前，任何拿到地址的人都能抢先注册。注册后默认关闭公开注册。
2. 检查健康接口：

   ```bash
   curl https://autonote.ouraihub.com/api/health
   ```

3. 需要时看实时日志：

   ```bash
   pnpm --filter autonote-web exec wrangler tail autonote
   ```

## 7. 绑定自定义域名

**本仓库已配置好 `autonote.ouraihub.com`**（`web/wrangler.toml` 与 `web/wrangler.kv.toml` 中的 `routes` 和 `PUBLIC_URL`），`ouraihub.com` 已由 Cloudflare 解析，按第 3 或第 4 节部署即可，本节无需操作。

以下供更换域名或 fork 后使用自己的域名时参考，以 `notes.example.com` 为例；**两个 toml 文件都要改**，它们部署的是同一个 Worker。

### 7.1 让域名由 Cloudflare 托管

Worker 自定义域只能用**同一 Cloudflare 账号里、DNS 由 Cloudflare 解析**的域名（Cloudflare 叫“区域 / Zone”）。

- **域名在 Cloudflare 注册的**：已经是区域，跳过这一步。
- **域名在阿里云、腾讯云、GoDaddy 等处注册的**：
  1. 控制台 → **添加域** → 输入根域名 `example.com` → 选 Free 套餐。
  2. Cloudflare 会扫描并导入现有 DNS 记录，核对一遍，别漏掉邮箱（MX）等已有记录。
  3. Cloudflare 给出两个名称服务器（如 `xxx.ns.cloudflare.com`）。到原注册商的域名管理里，把 DNS 服务器改成这两个。
  4. 等待生效（通常几分钟到几小时），控制台里该域名状态变为“活动”。

只想用子域、又不能迁移整个根域时，需要 Cloudflare 付费套餐的子域委派或 CNAME 接入，本文不展开。

### 7.2 把域名挂到 Worker

二选一，推荐 A，配置跟着代码走。

**A. 写进 `web/wrangler.toml`（推荐）**

在顶部 `compatibility_flags` 附近加上：

```toml
workers_dev = true
routes = [{ pattern = "notes.example.com", custom_domain = true }]
```

然后正常部署（第 3 或第 4 节）。`wrangler deploy` 会自动创建该域名的 DNS 记录并签发 HTTPS 证书。注意：

- `pattern` 只写主机名，不带 `https://`，不带路径，不带 `*`。
- 该主机名上**不能已有** A / AAAA / CNAME 记录，有的话先在 DNS 页面删掉，否则部署报错。
- `workers_dev = true` 保留 `workers.dev` 地址；改成 `false` 就只能通过自定义域访问。
- 要绑定多个域名就在数组里多写几项。

**B. 在控制台添加**

控制台 → **Workers 和 Pages** → `autonote` → **设置** → **域和路由** → **添加** → **自定义域** → 填 `notes.example.com`。效果和 A 一样，但仓库里看不到这个配置。

### 7.3 设置 `PUBLIC_URL`

在 `web/wrangler.toml` 的 `[vars]` 里加上，然后重新部署：

```toml
[vars]
APP_NAME = "AutoNote"
PUBLIC_URL = "https://notes.example.com"
```

| 功能 | 不设 `PUBLIC_URL` | 设了以后 |
| --- | --- | --- |
| 网页、同步、分享链接 | 用当前访问的域名，不受影响 | 不变 |
| MCP 设置页显示的端点 | 显示当前访问的域名 | 固定显示 `PUBLIC_URL` |
| MCP OAuth 授权（Claude 等客户端接入） | 按访问域名生成，换个域名访问就对不上 | 固定用 `PUBLIC_URL`，客户端配置一次即可 |

规则：必须是 `https://`，只取协议加主机名部分，写错时自动回退为“用当前访问的域名”（`web/src/worker/mcp/oauth.ts`、`web/src/worker/routes/mcp-settings.ts`）。

请写在 `wrangler.toml` 里，不要只在控制台改：每次 `wrangler deploy` 都会用配置文件里的变量覆盖控制台的设置。

### 7.4 验证

```bash
curl https://notes.example.com/api/health
```

- 返回健康信息即成功。
- 刚绑定时浏览器若报证书错误，等几分钟让证书签发完成。
- 用 MCP 的话，在设置 → MCP 页确认显示的端点是 `https://notes.example.com/mcp`。

### 7.5 换域名

1. 在 `routes` 里加上新域名，`PUBLIC_URL` 改成新域名，部署。
2. 已接入 MCP 的客户端要按新端点重新授权。
3. 确认新域名可用后，再从 `routes` 删掉旧域名并重新部署。

通过分享功能已发出的旧链接用的是旧域名，旧域名下线后这些链接会失效。

## 8. 回滚

- 控制台 → `autonote` → **部署** → 选择之前的版本 → **回滚**。
- 或者命令行：`pnpm --filter autonote-web exec wrangler rollback`。

回滚只回退 Worker 代码，不回退 D1、R2、KV 里的数据。

## 9. 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Please enable R2 through the Cloudflare Dashboard` | 账号未开通 R2 | 按 1.2 开通，或改用 KV 模式 |
| `Authentication error [code: 10000]` | Token 权限不足或选错账户 | 按 1.3 核对权限和“账户资源” |
| `More than one account available` | Token 能访问多个账号 | 设置 `CLOUDFLARE_ACCOUNT_ID` |
| Actions 里 `deploy` 显示 skipped | 不是手动触发、没勾选 deploy，或分支不是 `main` | 按第 4 节第 4 步重新触发 |
| `Unsupported build mode` | `--mode` 只接受 `production`、`kv`、`demo` | 用 `package.json` 里现成的脚本 |
