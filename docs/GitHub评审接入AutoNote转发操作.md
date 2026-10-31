# GitHub AI 评审接入 AutoNote 模型转发

目标：让 AutoNote 仓库的 GitHub PR 自动评审通过已部署的 AutoNote 转发调用模型。只修改 GitHub 配置，不修改工作流或放宽合并检查。

## 1. 在 AutoNote 准备模型和访问密钥

1. 打开 <https://autonote.ouraihub.com>，登录所有者账号。
2. 在模型服务设置中确认要用于评审的服务商已启用，线路有可用的上游密钥，并已添加目标聊天模型。
3. **该线路协议必须是 OpenAI Chat Completions**。当前评审脚本固定请求 `/chat/completions`，不能直接使用只配置了 OpenAI Responses 或 Anthropic Messages 的线路；转发不会转换协议。
4. 打开「设置 → 模型转发」，开启「启用转发」。
5. 在「访问密钥」输入名称 `github-review`，点击「创建密钥」。
6. 立即复制生成的完整密钥，保存到自己的密码管理器。密钥明文只显示一次，关闭后无法再次读取；丢失时撤销旧密钥并重新创建。

这里创建的是 **AutoNote 转发访问密钥**，不是上游模型服务商的 API Key。不要把任何真实密钥写进本文、代码、PR 评论或聊天。

## 2. 修改 GitHub 的两个 Secrets

打开：<https://github.com/ouraihub/AutoNote/settings/secrets/actions>

路径：仓库 **Settings → Secrets and variables → Actions → Secrets**。

找到已有同名项，点击编辑按钮更新；不存在则点击 **New repository secret** 创建。

| Name          | Secret 值                                  |
| ------------- | ------------------------------------------ |
| `AI_BASE_URL` | `https://autonote.ouraihub.com/relay/v1`   |
| `AI_API_KEY`  | 第 1 节创建的 `github-review` 完整转发密钥 |

`AI_BASE_URL` 可直接复制下面这一行，不要填入 `/chat/completions`，也不要重复添加 `/v1`：

```text
https://autonote.ouraihub.com/relay/v1
```

保存后，评审脚本会请求：

```text
https://autonote.ouraihub.com/relay/v1/chat/completions
```

使用仓库级 Secrets，不是仅供部署使用的 `production` 环境 Secrets。不要修改 `RELEASE_TOKEN`，它与模型调用无关。

## 3. 修改评审模型变量 AI_MODEL

在同一设置页面切换到 **Variables** 页签，编辑已有的 `AI_MODEL`；不存在则点击 **New repository variable**。

| Name       | Value                       |
| ---------- | --------------------------- |
| `AI_MODEL` | 转发模型列表中的准确模型 ID |

- 不是模型的显示昵称，也不是服务商名称。
- 例如，只有当 AutoNote 已添加 `gpt-6.1-sol` 且其线路使用 OpenAI Chat Completions 时，才填写 `gpt-6.1-sol`。
- 可以通过已经配置好的 Cherry 获取模型列表；也可以调用转发的 `GET /relay/v1/models`，取 `data` 中 `protocol` 为 `openai-chat` 的条目的 `id`。
- 列表返回 `服务商名/模型名` 形式时，完整复制这个 `id`，不要自行去掉服务商前缀。
- 选择有足够上下文容量、能按要求返回 JSON 评审结论的模型。以实际使用的 release-kit 版本为准；升级后的普通请求最多 1,000,000 字符，全局一致性请求最多 2,000,000，整次累计最多 6,000,000（含规则、元数据和转义）。这是脚本安全上限，不是模型容量保证；创建 PR 前运行 `pnpm exec release-kit review-size --base origin/main` 预检。

## 4. 只重跑失败的 AI 评审

1. 打开 <https://github.com/ouraihub/AutoNote/actions>。
2. 左侧选择 **AI review**。
3. 找到需要恢复的 PR 对应的失败运行，例如 PR #12；确认是该 PR 当前提交的审查，不要误选旧提交。
4. 点击右上角 **Re-run jobs → Re-run failed jobs**。
5. 查看 **AI review → Review** 日志，确认新的模型调用和评审结论。

不需要重新推送代码，也不必重新运行整套三平台 CI。其他必需检查全部通过且评审通过后，工作流会开启正常自动合并；模型要求修改时，应先处理意见。

## 5. 不需要登记 GitHub 仓库或配置 OIDC

当前 `.github/workflows/ai-review.yml` 使用 `pull_request_target`，不属于 AutoNote 临时密钥换取允许的事件。

因此，本操作使用手动创建的长期转发密钥，保存到 GitHub 的 `AI_API_KEY`。无需在 AutoNote「GitHub 仓库」区域登记仓库，也无需增加 `id-token: write`；仅登记仓库不会让当前评审自动获得密钥。

## 6. 常见失败与费用

| 现象                                       | 检查项                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `401` 或 `invalid relay access key`        | `AI_API_KEY` 是否完整、是否误填了上游密钥、是否已被撤销                                   |
| `503` 且错误类型为 `relay_paused`          | AutoNote「启用转发」是否开启                                                              |
| `404`，提示模型未配置                      | `AI_MODEL` 是否与列表 ID 完全一致、服务商是否启用、线路协议是否为 OpenAI Chat Completions |
| 上游额度不足、限流或所有密钥暂停           | 给上游补充额度，或在 AutoNote 配置有额度的线路/密钥；转发本身不提供免费模型额度           |
| `Diff is ... over the 120000 review limit` | 拆分 PR；这不是密钥或转发地址错误，换地址也不会解决                                       |
| 模型未返回有效评审结论                     | 查看日志，确认所选模型支持当前请求和足够的上下文，并能按脚本要求返回 JSON                 |

重跑评审会真实调用上游模型并消耗其额度。若转发最终仍使用原来余额不足的同一上游密钥，请求仍会失败，不要反复重跑。

## 参考

- 本项目工作流：`.github/workflows/ai-review.yml`
- 审查组件：[`ouraihub/release-kit/review`](https://github.com/ouraihub/release-kit#ai-审查与自动合并)
- [GitHub 官方：使用 Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets?tool=webui)
- [GitHub 官方：重新运行工作流和任务](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
