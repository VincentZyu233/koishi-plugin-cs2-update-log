import { Context } from 'koishi'

import { Config } from './config'
import { Cs2UpdateLogRuntime } from './runtime'
import { classifyNews, getNewsLink } from './steam'
import { formatDate } from './utils/date'

export function registerCommands(ctx: Context, config: Config, runtime: Cs2UpdateLogRuntime) {
  ctx.command('cs2log.check', '查看最近最多 5 条 CS2 官方公告分类结果', {
    authority: config.checkCommandAuthority,
  })
    .action(async () => {
      const items = await runtime.fetchNews()
      if (!items.length) return '没有拉取到 CS2 官方新闻。'

      return items.slice(0, 5)
        .map((item, index) => {
          const category = classifyNews(item).category === 'update'
            ? '官方更新日志'
            : '官方公告'
          return [
            `${index + 1}. [${category}] ${item.title}`,
            `发布时间：${formatDate(item.date)}`,
            `gid：${item.gid}`,
            `链接：${getNewsLink(item)}`,
          ].join('\n')
        })
        .join('\n\n')
    })

  ctx.command('cs2log.push', '手动补发失败内容并推送新的 CS2 官方公告', {
    authority: config.pushCommandAuthority,
  })
    .action(async () => {
      return await runtime.manualPush()
    })

  ctx.command('cs2log.test', '测试推送最近最多 2 条 CS2 官方新闻', {
    authority: config.testCommandAuthority,
  })
    .action(async ({ session }) => {
      if (!session?.bot || !session.channelId) {
        return '测试指令需要在可发送消息的会话中使用。'
      }

      const items = await runtime.fetchNews()
      const testItems = items.slice(0, 2).reverse()
      if (!testItems.length) return '没有拉取到可测试推送的 CS2 官方新闻。'

      const notices = new Set<string>()
      for (const item of testItems) {
        const rendered = await runtime.buildNewsMessage(classifyNews(item))
        await session.bot.sendMessage(session.channelId, rendered.content)
        if (rendered.notice) notices.add(rendered.notice)
      }

      return [
        `已向当前会话触发 ${testItems.length} 条 CS2 官方新闻测试推送。本次测试不会写入 gid 判重 state。`,
        ...Array.from(notices, (notice) => `⚠️ ${notice}`),
      ].join('\n')
    })

  ctx.command('cs2log.ai', '使用 LLM 总结最近最多 5 条 CS2 官方新闻', {
    authority: config.aiCommandAuthority,
  })
    .option('broadcast', '-b, --broadcast 向当前会话与配置目标广播摘要', {
      authority: config.aiBroadcastAuthority,
    })
    .action(async ({ session, options }) => {
      if (!config.enableLlmSummary) {
        return 'LLM 摘要功能未开启，请先在插件配置中启用 enableLlmSummary。'
      }
      if (!session?.bot || !session.channelId) {
        return 'AI 摘要指令需要在可发送消息的会话中使用。'
      }

      return await runtime.runAiSummary(session, !!options?.broadcast)
    })
}
