# koishi-plugin-cs2-update-log

作者：BestBcz

Koishi QQ 机器人插件，用于轮询 CS2 官方 Steam 公告流，按 `gid` 判重后将官方更新日志或官方公告推送到指定群。

## 功能

- 使用 Steam Store RSS `https://store.steampowered.com/feeds/news/app/730/` 拉取 AppID `730` 的官方公告流，避开 `api.steampowered.com`。
- 默认每 30 秒轮询一次。
- 首次启动默认只记录历史 `gid`，不推送历史内容。
- 自动分类：
  - 标题包含 `Counter-Strike 2 Update` / `Release Notes`
  - 或正文包含 `[MAPS]`、`[GAMEPLAY]`、`[MISC]`、`[AUDIO]`、`[ITEMS]`、`[WORKSHOP]`、`[PREMIER]` 等更新分区
- 支持纯文本推送或 Puppeteer 深色长图卡片推送。
- 支持 OpenAI-compatible Chat Completions API 翻译。
- 提供 `cs2log.check` 与 `cs2log.push` 命令。

## 配置要点

- `targets` 必须配置目标 QQ 群，其中 `channelId` 一般填写群号。
- `picture` 开启后需要安装并启用 Puppeteer 服务插件，例如 `@koishijs/plugin-puppeteer`。
- `trans` 开启后需要填写 `translateApiKey`；默认接口是 OpenAI Chat Completions 格式，可按你的服务商修改 `translateApiEndpoint` 和 `translateModel`。

## 命令

- `cs2log.check`：查看最近 5 条新闻的分类结果。
- `cs2log.push`：手动检查并推送新内容。
