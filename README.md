# koishi-plugin-cs2-update-log

[![Github](https://img.shields.io/badge/-Github-000?style=flat&logo=Github&logoColor=white)](https://github.com/BestBcz/koishi-cs2-update-log)
[![npm](https://img.shields.io/npm/v/koishi-plugin-cs2-update-log?style=flat&color=DB4527)](https://www.npmjs.com/package/koishi-plugin-cs2-update-log)
[![KoishiForum](https://img.shields.io/badge/Forum-Koishi?style=flat-square&label=Koishi&color=8029F2
)](https://forum.koishi.xyz/t/topic/12652)

[Koishi QQ 机器人](https://koishi.chat/) 插件，用于轮询 CS2 官方公告流，按 `gid` 判重后将官方更新日志或官方公告推送到指定群。

## 功能

- 使用RSS拉取 `CS2` 的更新公告。
- 默认每 30 秒轮询一次。
- 首次启动默认只记录历史 `gid`，不推送历史内容。
- 自动分类：
  - 标题包含 `Counter-Strike 2 Update` / `Release Notes`
  - 或正文包含 `[MAPS]`、`[GAMEPLAY]`、`[MISC]`、`[AUDIO]`、`[ITEMS]`、`[WORKSHOP]`、`[PREMIER]` 等更新分区
- 支持纯文本推送或 Puppeteer 深色长图卡片推送。
- 支持 OpenAI-compatible Chat Completions API 翻译。
- 优秀的发现速度和推送速度。
- 缓存系统 ，减少连续推送的开销。
- 提供 `cs2log.check`、`cs2log.push` 与 `cs2log.test` 命令。

## 配置要点

- `targets` 必须配置目标 QQ 群，其中 `channelId` 一般填写群号。
- `picture` 开启后需要安装并启用 Puppeteer 服务插件
- `trans` 开启后需要填写 `translateApiKey`；默认接口是 OpenAI Chat Completions 格式，可按你的服务商修改 `translateApiEndpoint` 和 `translateModel`。AI 翻译请求超时时间为 90 秒。

## 命令

- `cs2log.check`：查看最近 5 条新闻的分类结果。
- `cs2log.push`：手动检查并推送新内容。
- `cs2log.test`：在输入该指令的当前群测试推送最近 2 条新闻。

## 示例
<img width="673" height="981" alt="367edde18a4814d125054ada25783c1c" src="https://github.com/user-attachments/assets/fa30d1f8-0783-4bab-93ef-fd06bcab9132" />


