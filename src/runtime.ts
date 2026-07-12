import { Context, Universal } from 'koishi'
import type { Fragment, Session } from 'koishi'

import type { Config } from './config'
import { DeliveryManager, DeliveryReport, DeliveryTarget } from './delivery'
import { FontManager } from './font'
import { LlmClient } from './llm'
import { NewsRenderer, RenderResult } from './render'
import { StateStore } from './state'
import {
  ClassifiedNews,
  SteamNewsClient,
  SteamNewsItem,
  classifyNews,
  getNewsLink,
  steamContentToMarkdown,
} from './steam'
import { SummaryRenderer } from './summary'
import { formatDate } from './utils/date'
import { formatError } from './utils/error'

const LOGGER_NAME = 'cs2-update-log'
const RUNTIME_CACHE_CLEAR_INTERVAL_MS = 5 * 60 * 1000

export type PollSource = 'startup' | 'timer' | 'manual' | 'online'

interface PushRunResult {
  retriedNews: number
  newNews: number
  successCount: number
  failureCount: number
  unresolvedTargetCount: number
  canceledCount: number
  notices: Set<string>
  busy?: boolean
  noTargets?: boolean
  initializedOnly?: boolean
  preflightCanceled?: boolean
  canceledDuringRun?: boolean
  error?: string
}

export class Cs2UpdateLogRuntime {
  private readonly logger: ReturnType<Context['logger']>
  private readonly steam: SteamNewsClient
  private readonly renderer: NewsRenderer
  private readonly summaryRenderer: SummaryRenderer
  private readonly llm: LlmClient
  private readonly delivery: DeliveryManager
  private readonly state: StateStore
  private readonly font: FontManager

  private polling = false
  private appReady = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    this.logger = ctx.logger(LOGGER_NAME)
    this.steam = new SteamNewsClient(ctx, () => config.count)
    this.font = new FontManager(ctx, config.fontPath)
    this.renderer = new NewsRenderer(ctx, config, this.font)
    this.summaryRenderer = new SummaryRenderer(ctx, config, this.font)
    this.llm = new LlmClient(ctx, config)
    this.delivery = new DeliveryManager(ctx, config)
    this.state = new StateStore(ctx, config.stateFile)
  }

  start() {
    if (this.config.picture) void this.font.load().catch(() => undefined)
    this.ctx.on('ready', async () => {
      this.appReady = true
      try {
        await this.pollWhenTargetsOnline('startup')
      } catch (error) {
        this.logger.error('启动 CS2 新闻轮询失败：%s', formatError(error))
      }
    })

    this.ctx.on('bot-status-updated', async (bot) => {
      if (bot.status !== Universal.Status.ONLINE) return
      const matchesTarget = this.config.targets.some((target) => {
        if (target.enabled === false) return false
        if (target.platform && bot.platform !== target.platform) return false
        if (target.selfId && bot.selfId !== target.selfId) return false
        return true
      })
      if (!matchesTarget) return

      try {
        await this.pollWhenTargetsOnline('online')
      } catch (error) {
        this.logger.error('机器人上线后检查 CS2 新闻失败：%s', formatError(error))
      }
    })

    this.ctx.setInterval(() => {
      void this.pollWhenTargetsOnline('timer')
    }, Math.max(5, this.config.interval) * 1000)

    this.ctx.setInterval(() => {
      this.clearRuntimeCache('short cache interval')
    }, RUNTIME_CACHE_CLEAR_INTERVAL_MS)
  }

  fetchNews() {
    return this.steam.fetchNews()
  }

  allTargetBotsOnline() {
    const targets = this.delivery.resolveConfiguredTargets()
    return !!targets.length && targets.every((target) => !!target.bot)
  }

  async pollWhenTargetsOnline(source: PollSource) {
    if (!this.appReady) {
      this.logger.debug('应用尚未 ready，跳过本次 %s 轮询。', source)
      return 0
    }

    const result = await this.runPush(source, false)
    if (result.error) {
      this.logger.error('检查并推送 CS2 新闻失败：%s', result.error)
    } else if (result.preflightCanceled || result.canceledDuringRun) {
      this.logger.debug('本次 %s 严格推送已取消；此前处理 %d 条，成功 %d 次、失败 %d 次。', source, result.newNews, result.successCount, result.failureCount)
    } else if (result.newNews) {
      this.logger.info(
        '本次 %s 已处理 %d 条新新闻，目标成功 %d 次、失败 %d 次。',
        source,
        result.newNews,
        result.successCount,
        result.failureCount,
      )
    }
    return result.newNews
  }

  async manualPush() {
    const result = await this.runPush('manual', true)
    if (result.error) this.logger.error('手动推送 CS2 新闻失败：%s', result.error)
    return formatManualPushResult(result)
  }

  async buildNewsMessage(news: ClassifiedNews): Promise<RenderResult> {
    const link = getNewsLink(news.item)
    const baseMarkdown = steamContentToMarkdown(news.item.content)
    const translated = await this.llm.translate(news.item.title, baseMarkdown)

    return this.renderer.renderOrFallbackText(
      news,
      translated.title,
      translated.markdown,
      link,
    )
  }

  async buildNewsContent(news: ClassifiedNews) {
    return (await this.buildNewsMessage(news)).content
  }

  async runAiSummary(session: Session, broadcast: boolean): Promise<Fragment> {
    if (!this.config.enableLlmSummary) {
      return 'LLM 摘要功能未开启，请先启用 enableLlmSummary。'
    }
    if (!session.bot || !session.channelId) {
      return 'AI 摘要指令需要在可发送消息的会话中使用。'
    }

    try {
      const limit = Math.min(Math.max(1, this.config.count), 5)
      const items = (await this.fetchNews()).slice(0, limit)
      if (!items.length) return '没有拉取到可供 LLM 总结的 CS2 官方新闻。'

      const summary = await this.llm.summarize(items.map((item) => ({
        title: item.title,
        markdown: steamContentToMarkdown(item.content),
        publishedAt: formatDate(item.date),
        author: item.author,
      })))
      const sources = items.map((item) => ({
        title: item.title,
        date: item.date,
        link: getNewsLink(item),
      }))
      const rendered = await this.summaryRenderer.renderOrFallbackText(summary, sources)
      if (!broadcast) return appendNotice(rendered.content, rendered.notice)

      const targets = this.delivery.collectSummaryTargets(session)
      const report = await this.delivery.send(
        rendered.content,
        targets,
        this.config.allowPartialAiBroadcast,
      )
      return formatBroadcastReport(report, rendered.notice)
    } catch (error) {
      this.logger.error('生成 AI 摘要失败：%s', formatError(error))
      return '生成 AI 摘要失败，请检查插件日志。'
    }
  }

  private clearRuntimeCache(reason: string) {
    this.steam.clearCache()
    this.renderer.clearCache()
    this.summaryRenderer.clearCache()
    this.llm.clearCache()
    this.font.clearCache()
    this.logger.info('已清理运行时缓存：%s', reason)
  }

  private ensureStateLoaded() {
    return this.state.load()
  }

  private async runPush(source: PollSource, retryFailures: boolean): Promise<PushRunResult> {
    const result = createPushRunResult()
    if (this.polling) {
      result.busy = true
      return result
    }

    this.polling = true
    try {
      await this.ensureStateLoaded()
      const targets = this.delivery.resolveConfiguredTargets()
      if (!targets.length) {
        result.noTargets = true
        return result
      }

      const allowPartial = source === 'manual'
        ? this.config.allowPartialManualPush
        : this.config.allowPartialAutoPush
      if (!allowPartial && targets.some((target) => !target.bot)) {
        result.preflightCanceled = true
        result.canceledCount = 1
        result.failureCount = targets.length
        return result
      }

      if (retryFailures && await this.retryFailedNews(targets, allowPartial, result)) return result

      const items = await this.fetchNews()
      if (!items.length) return result

      if (this.state.isFirstRun && !this.config.pushOnFirstRun) {
        this.state.markAll(items)
        result.initializedOnly = true
        await this.state.save(items)
        this.logger.info('首次启动已记录 %d 条历史新闻，不推送。', items.length)
        return result
      }

      const freshItems = items
        .filter((item) => !this.state.has(item.gid))
        .sort(compareNewsOldestFirst)

      for (const item of freshItems) {
        const rendered = await this.buildNewsMessage(classifyNews(item))
        if (rendered.notice) result.notices.add(rendered.notice)
        const report = await this.delivery.send(rendered.content, targets, allowPartial)
        if (report.canceled) { result.canceledDuringRun = true; mergeReport(result, report); return result }
        this.state.applyDeliveryReport(item, report)
        this.state.mark(item)
        result.newNews += 1
        mergeReport(result, report)
        await this.state.save(items)
      }

      if (!freshItems.length) await this.state.save(items)
      return result
    } catch (error) {
      result.error = formatError(error)
      return result
    } finally {
      this.polling = false
    }
  }

  private async retryFailedNews(
    configuredTargets: DeliveryTarget[],
    allowPartial: boolean,
    result: PushRunResult,
  ) {
    for (const delivery of this.state.getPendingDeliveries()) {
      const targets = configuredTargets
        .filter((target) => target.stateKeys.some((key) => delivery.targetKeys.has(key)))
        .map((target) => ({ ...target, stateKeys: target.stateKeys.filter((key) => delivery.targetKeys.has(key)) }))
      const resolvedKeys = new Set(targets.flatMap((target) => target.stateKeys))
      result.unresolvedTargetCount += Array.from(delivery.targetKeys)
        .filter((key) => !resolvedKeys.has(key)).length
      if (!targets.length) continue

      const rendered = await this.buildNewsMessage(classifyNews(delivery.item))
      if (rendered.notice) result.notices.add(rendered.notice)
      const report = await this.delivery.send(rendered.content, targets, allowPartial)
      if (report.canceled) { result.canceledDuringRun = true; mergeReport(result, report); return true }
      this.state.applyDeliveryReport(delivery.item, report)
      result.retriedNews += 1
      mergeReport(result, report)
      await this.state.save()
    }
    return false
  }
}

function createPushRunResult(): PushRunResult {
  return {
    retriedNews: 0,
    newNews: 0,
    successCount: 0,
    failureCount: 0,
    unresolvedTargetCount: 0,
    canceledCount: 0,
    notices: new Set(),
  }
}

function mergeReport(result: PushRunResult, report: DeliveryReport) {
  result.successCount += report.successCount
  result.failureCount += report.failureCount
  if (report.canceled) result.canceledCount += 1
}

function compareNewsOldestFirst(left: SteamNewsItem, right: SteamNewsItem) {
  return left.date - right.date || left.gid.localeCompare(right.gid)
}

function formatManualPushResult(result: PushRunResult) {
  if (result.busy) return '已有 CS2 新闻检查任务正在执行，请稍后再试。'
  if (result.noTargets) return '未配置推送目标，未执行手动推送。'
  if (result.preflightCanceled) {
    return `检测到不可用目标，已取消整次手动推送。目标成功 0 次、失败 ${result.failureCount} 次。`
  }
  if (result.initializedOnly) {
    if (result.error) return '首次运行已读取历史新闻，但 gid state 写入失败，请查看插件日志。'
    return '首次运行已建立 gid 判重 state；pushOnFirstRun 关闭，因此本次没有推送历史新闻。'
  }

  const activity = result.retriedNews || result.newNews
    ? `已补发处理 ${result.retriedNews} 条历史失败新闻，并处理 ${result.newNews} 条新新闻。`
    : '没有需要补发或推送的新新闻。'
  const delivery = `目标发送成功 ${result.successCount} 次、失败 ${result.failureCount} 次。`
  const unresolved = result.unresolvedTargetCount
    ? `另有 ${result.unresolvedTargetCount} 个历史失败目标已不在当前 targets 中，记录已保留。`
    : ''
  const canceled = result.canceledDuringRun ? '后续发送因目标不可用而取消。' : ''
  const error = result.error ? '后续检查发生错误，请查看插件日志。' : ''
  const notices = Array.from(result.notices, (notice) => `⚠️ ${notice}`)
  return [activity, delivery, unresolved, canceled, error, ...notices].filter(Boolean).join('\n')
}

function formatBroadcastReport(report: DeliveryReport, notice?: string) {
  const headline = report.canceled
    ? `AI 摘要广播已取消：${report.reason || '存在不可用目标。'}`
    : 'AI 摘要广播完成。'
  const summary = `成功 ${report.successCount} 个目标，失败 ${report.failureCount} 个目标。`
  const failures = report.results
    .filter((item) => !item.success)
    .map((item) => `${item.target.label}：${item.error || '发送失败'}`)
  return [headline, summary, ...failures, notice ? `⚠️ ${notice}` : ''].filter(Boolean).join('\n')
}

function appendNotice(content: Fragment, notice?: string): Fragment {
  if (!notice) return content
  return Array.isArray(content) ? [...content, '\n⚠️ ', notice] : [content, '\n⚠️ ', notice]
}
