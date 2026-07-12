import { Context, h, Session } from 'koishi'
import type { Fragment } from 'koishi'

import { Config } from './config'
import { Cs2UpdateLogRuntime } from './runtime'
import { classifyNews, getNewsLink } from './steam'
import { formatDate } from './utils/date'

function buildPrefix(config: Config, session: Session): string {
  return config.enableQuote ? `${h.quote(session.messageId)}` : ''
}

function prependQuote(config: Config, session: Session, content: Fragment): Fragment {
  if (!config.enableQuote) return content
  const quote = h.quote(session.messageId)
  return Array.isArray(content) ? [quote, ...content] : [quote, content]
}

async function sendHint(config: Config, session: Session, prefix: string, text: string): Promise<string | null> {
  if (!config.enableWaitingHint) return null
  const msgIds = await session.send(`${prefix}${text}`)
  return msgIds?.[0] ?? null
}

async function deleteHint(session: Session, hintMsgId: string | null): Promise<void> {
  if (!hintMsgId || !session.channelId) return
  await session.bot?.deleteMessage(session.channelId, hintMsgId).catch(() => {})
}

export function registerCommands(ctx: Context, config: Config, runtime: Cs2UpdateLogRuntime) {
  ctx.command('cs2log.check', '查看最近最多 5 条 CS2 官方公告分类结果', {
    authority: config.checkCommandAuthority,
  })
    .action(async ({ session }) => {
      if (!session) return
      const prefix = buildPrefix(config, session)
      const hintMsgId = await sendHint(config, session, prefix, '🔍 正在检查 CS2 新闻，请稍候...')
      try {
        const items = await runtime.fetchNews()
        if (!items.length) {
          await session.send(`${prefix}没有拉取到 CS2 官方新闻。`)
          return
        }

        const result = items.slice(0, 5)
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
        await session.send(`${prefix}${result}`)
      } finally {
        await deleteHint(session, hintMsgId)
      }
    })

  ctx.command('cs2log.push', '手动补发失败内容并推送新的 CS2 官方公告', {
    authority: config.pushCommandAuthority,
  })
    .action(async ({ session }) => {
      if (!session) return
      const prefix = buildPrefix(config, session)
      const hintMsgId = await sendHint(config, session, prefix, '📢 正在推送 CS2 新闻，请稍候...')
      try {
        const result = await runtime.manualPush()
        await session.send(`${prefix}${result}`)
      } finally {
        await deleteHint(session, hintMsgId)
      }
    })

  ctx.command('cs2log.test', '测试推送最近最多 2 条 CS2 官方新闻', {
    authority: config.testCommandAuthority,
  })
    .action(async ({ session }) => {
      if (!session) return
      const prefix = buildPrefix(config, session)

      if (!session.bot || !session.channelId) {
        await session.send(`${prefix}测试指令需要在可发送消息的会话中使用。`)
        return
      }

      const hintMsgId = await sendHint(config, session, prefix, '🧪 正在测试推送 CS2 新闻，请稍候...')
      try {
        const items = await runtime.fetchNews()
        const testItems = items.slice(0, 2).reverse()
        if (!testItems.length) {
          await session.send(`${prefix}没有拉取到可测试推送的 CS2 官方新闻。`)
          return
        }

        const notices = new Set<string>()
        for (const item of testItems) {
          const rendered = await runtime.buildNewsMessage(classifyNews(item))
          await session.bot.sendMessage(
            session.channelId,
            prependQuote(config, session, rendered.content),
          )
          if (rendered.notice) notices.add(rendered.notice)
        }

        const summary = [
          `已向当前会话触发 ${testItems.length} 条 CS2 官方新闻测试推送。本次测试不会写入 gid 判重 state。`,
          ...Array.from(notices, (notice) => `⚠️ ${notice}`),
        ].join('\n')
        await session.send(`${prefix}${summary}`)
      } finally {
        await deleteHint(session, hintMsgId)
      }
    })

  ctx.command('cs2log.ai', '使用 LLM 总结最近最多 5 条 CS2 官方新闻', {
    authority: config.aiCommandAuthority,
  })
    .option('broadcast', '-b, --broadcast 向当前会话与配置目标广播摘要', {
      authority: config.aiBroadcastAuthority,
    })
    .action(async ({ session, options }) => {
      if (!session) return
      const prefix = buildPrefix(config, session)

      if (!config.enableLlmSummary) {
        await session.send(`${prefix}LLM 摘要功能未开启，请先在插件配置中启用 enableLlmSummary。`)
        return
      }
      if (!session.bot || !session.channelId) {
        await session.send(`${prefix}AI 摘要指令需要在可发送消息的会话中使用。`)
        return
      }

      const hintMsgId = await sendHint(config, session, prefix, '🤖 正在生成 AI 摘要，请稍候...')
      try {
        const result = await runtime.runAiSummary(session, !!options?.broadcast)
        await session.send(`${prefix}${result}`)
      } finally {
        await deleteHint(session, hintMsgId)
      }
    })
}
