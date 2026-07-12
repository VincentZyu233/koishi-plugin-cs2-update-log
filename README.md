# koishi-plugin-cs2-update-log

[![Github](https://img.shields.io/badge/-Github-000?style=flat&logo=Github&logoColor=white)](https://github.com/BestBcz/koishi-cs2-update-log)
[![npm](https://img.shields.io/npm/v/koishi-plugin-cs2-update-log?style=flat&color=DB4527)](https://www.npmjs.com/package/koishi-plugin-cs2-update-log)
[![KoishiForum](https://img.shields.io/badge/Forum-Koishi?style=flat-square&label=Koishi&color=8029F2)](https://forum.koishi.xyz/t/topic/12652)

[Koishi QQ 机器人](https://koishi.chat/) 插件，用于轮询 CS2 官方 Steam 新闻，记录全局 `gid` 与按目标失败快照，并将官方更新日志或公告推送到指定频道或 QQ 群。

## 功能

- 从 Steam Fastly RSS、Steam Web API 与 Store RSS 获取 CS2 官方新闻。
- 自动识别更新日志与普通官方公告。
- 支持纯文本或 Puppeteer 深色长图推送，渲染失败自动降级。
- 自动下载并内嵌 LXGW WenKai Mono 字体，失败时继续使用系统字体出图。
- 支持 OpenAI-compatible Chat Completions 与 Anthropic Messages API。
- 可使用 LLM 翻译单篇新闻，或将最近最多 5 条新闻合并为一份摘要。
- 按目标记录正式新闻投递结果，部分目标失败时不会让成功目标重复接收。
- 首次启动默认只建立历史状态，不推送旧内容。

## 命令与影响范围

假设命令在群 D 执行，而 `targets` 配置了群 A、B、C。这里的配置目标并不是 Koishi 的所有会话。

| 命令 | 当前会话（群 D） | 配置目标（群 A、B、C） | 调用 LLM | 生成图片 | 写入 gid state |
|---|---|---|---|---|---|
| `cs2log.check` | 返回最近最多 5 条新闻的分类、时间、gid 与链接 | 不发送 | 否 | 否 | 否 |
| `cs2log.push` | 返回补发与新推送结果 | 先补发历史失败内容，再推送尚未处理的新内容 | 按 `enableLlmTranslate` | 按 `picture` | 是，记录 gid 与失败目标 |
| `cs2log.test` | 测试发送最近最多 2 条完整新闻 | 不发送 | 按 `enableLlmTranslate` | 按 `picture` | 否 |
| `cs2log.ai` | 发送一条合并 AI 摘要 | 不发送 | 是 | 按 `picture` | 否 |
| `cs2log.ai --broadcast` | 发送完整摘要与结果统计 | 发送同一份完整摘要 | 是，只调用一次 | 按 `picture`，只渲染一次 | 否 |

`check` 与 `ai` 的实际新闻数量受 `count` 限制，并且最多为 5 条。`test` 最多为 2 条，同样受 `count` 限制。

`cs2log.ai --broadcast` 的发送范围是“当前会话 ∪ 配置 targets”。当前会话已在 `targets` 中时会自动去重，只收到一份摘要。LLM 只调用一次，摘要图片也只渲染一次，然后复用同一份内容发送。

## 配置

### ⏱️ 轮询与状态

- `interval`：轮询间隔，默认 30 秒，最小 5 秒。
- `count`：单次拉取数量，默认 5；AI 摘要数量为 `min(count, 5)`。
- `stateFile`：保存全局 gid 与按目标失败快照的状态文件。
- `pushOnFirstRun`：首次启动是否推送已存在的历史新闻，默认 `false`。

### 🎯 推送目标与策略

- `targets`：目标平台、机器人账号和频道列表。OneBot QQ 群的 `channelId` 通常直接填写群号。
- `allowPartialAutoPush`：自动推送是否允许部分目标失败，默认 `true`。
- `allowPartialManualPush`：手动 `cs2log.push` 是否允许部分目标失败，默认 `true`。
- `allowPartialAiBroadcast`：`cs2log.ai --broadcast` 是否允许部分目标失败，默认 `true`。

部分失败策略开启时，插件会跳过失败目标并继续发送其他目标。关闭时，如果发送前发现目标不可用，会取消对应操作。目标在实际发送过程中突然失败时，已经成功发送的消息无法回滚，插件会按真实结果记录或报告。

正式新闻自动发送失败后不会由定时器反复补发。管理员下次执行 `cs2log.push` 时，会先按发布时间从旧到新补发历史失败内容，再按同一顺序处理新内容；已经成功的目标不会重复收到。

AI 广播不写入 state，也不保存旧摘要任务。失败目标会显示在本次统计中，需要时可重新执行命令。

### 🖼️ 图片显示

- `brandName`、`siteName`：新闻与摘要卡片的品牌文字。
- `picture`：启用 Puppeteer 长图；关闭或渲染失败时发送纯文本。
- `fontPath`：LXGW WenKai Mono 字体路径。配置页默认展示 `process.cwd()/data/fonts/LXGWWenKaiMono-Regular.ttf`，运行时映射到 `ctx.baseDir/data/fonts/LXGWWenKaiMono-Regular.ttf`。
- `appendLink`：长图成功时是否追加真实 Steam 来源链接。

默认托管字体不存在或完整性校验失败时，插件会先从 [Gitee Release](https://gitee.com/vincent-zyu/koishi-plugin-awa-quote-image/releases/download/fonts/LXGWWenKaiMono-Regular.ttf) 下载，再尝试 [GitHub Release](https://github.com/VincentZyuApps/koishi-plugin-awa-quote-image/releases/download/fonts/LXGWWenKaiMono-Regular.ttf)。下载使用临时文件，完成大小与多重哈希校验后再原子替换正式文件。

如果手动填写了自定义 `fontPath`，插件会严格读取该路径，不会改用默认 LXGW。自定义字体不可用或默认字体双源下载均失败时，图片仍会使用系统字体；只有 Puppeteer 本身不可用或截图失败时才降级为纯文本。字体失败结果会缓存 5 分钟，避免批量新闻重复等待下载超时，缓存清理后会再次尝试。

`cs2log.push`、`cs2log.test` 与 `cs2log.ai` 会在当前会话报告字体或图片 fallback；自动轮询只写插件日志，不会在正式公告后附加技术提示。LXGW WenKai 遵循 SIL Open Font License 1.1。

### 🤖 LLM 设置

- `enableLlmTranslate`：控制自动新闻、`push` 和 `test` 的 LLM 翻译，默认 `false`。
- `enableLlmSummary`：只控制手动 `cs2log.ai`，默认 `false`，不会参与 RSS 自动轮询。
- `llmApiFormat`：`openai` 或 `anthropic`，默认 `openai`。
- `llmApiKey`：翻译与摘要共用的 API Key。
- `llmApiEndpoint`：完整 API 地址，默认 `https://api.deepseek.com/chat/completions`。
- `llmModel`：共用模型名，默认 `deepseek-v4-flash`。
- `llmMaxTokens`：最大输出 Token 数，默认 4096，可设置 256～32768。
- `llmTranslatePrompt`：逐篇新闻翻译提示词。
- `llmSummaryPrompt`：合并摘要提示词，决定摘要的内容、格式与输出语言。

使用 Anthropic 格式时，将 `llmApiFormat` 改为 `anthropic`，并将接口改为服务商提供的 Messages API 完整地址，例如 `https://api.anthropic.com/v1/messages`。

OpenAI 格式默认发送兼容服务常见的 `max_tokens`；如果接口明确拒绝该参数，插件会自动改用 `max_completion_tokens` 重试一次。

默认摘要 Prompt 要求输出一份简体中文 Markdown 摘要。需要英文或其他语言时，直接修改 `llmSummaryPrompt` 的语言要求，无需额外语言配置。

### ⌨️ 命令权限

| 配置 | 默认值 | 保护范围 |
|---|---:|---|
| `checkCommandAuthority` | 1 | `cs2log.check` |
| `pushCommandAuthority` | 2 | `cs2log.push` |
| `testCommandAuthority` | 2 | `cs2log.test` |
| `aiCommandAuthority` | 2 | `cs2log.ai` |
| `aiBroadcastAuthority` | 2 | `cs2log.ai --broadcast` 选项 |

## State 与判重

State 是插件自己的本地投递记录，并不是 RSS 的一部分。全局 `gids` 表示新闻已经进入正式投递流程，`failedDeliveries` 只保存尚未收到的目标与新闻快照，用于避免成功目标重复接收或失败目标永久漏发。

只有自动正式推送与 `cs2log.push` 会更新 state。`check`、`test`、`ai` 和 `ai --broadcast` 都不会修改它，因此可以反复检查或测试。

从旧版全局 `gids` state 升级时，历史 gid 会视为当前目标均已收到，避免升级后突然重发旧新闻。

## 旧配置迁移

旧版 LLM 翻译字段已删除，不保留兼容别名，请同步更新 Koishi 配置：

| 旧字段 | 新字段 |
|---|---|
| `trans` | `enableLlmTranslate` |
| `translateApiKey` | `llmApiKey` |
| `translateApiEndpoint` | `llmApiEndpoint` |
| `translateModel` | `llmModel` |
| `translatePrompt` | `llmTranslatePrompt` |

摘要功能还需要按需启用 `enableLlmSummary`，并可通过 `llmSummaryPrompt` 自定义语言和输出结构。

## 示例

<img width="673" height="981" alt="CS2 更新日志推送示例" src="https://github.com/user-attachments/assets/fa30d1f8-0783-4bab-93ef-fd06bcab9132" />
