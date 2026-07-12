import { Context, Universal } from 'koishi'
import type { Bot, Fragment, Session } from 'koishi'

import type { Config, TargetConfig } from './config'
import { formatError } from './utils/error'

export interface DeliveryTarget {
  identity: string
  stateKeys: string[]
  label: string
  channelId: string
  bot?: Bot
}

export interface DeliveryResult {
  target: DeliveryTarget
  success: boolean
  error?: string
}

export interface DeliveryReport {
  canceled: boolean
  reason?: string
  results: DeliveryResult[]
  successCount: number
  failureCount: number
}

export class DeliveryManager {
  private readonly logger = this.ctx.logger('cs2-update-log')

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  getConfiguredStateKeys() {
    return new Set(this.config.targets.map(getTargetStateKey))
  }

  resolveConfiguredTargets() {
    return mergeDuplicateTargets(
      this.config.targets.map((target) => this.resolveConfiguredTarget(target)),
    )
  }

  resolveConfiguredTargetByStateKey(stateKey: string) {
    return this.resolveConfiguredTargets()
      .find((target) => target.stateKeys.includes(stateKey))
  }

  collectSummaryTargets(session: Session) {
    const targets = this.resolveConfiguredTargets()
    const current = createSessionTarget(session)
    const unique = new Map<string, DeliveryTarget>()

    for (const target of [...targets, current]) {
      const existing = unique.get(target.identity)
      if (!existing || (!existing.bot && target.bot)) unique.set(target.identity, target)
    }

    return Array.from(unique.values())
  }

  async send(
    content: Fragment,
    targets: DeliveryTarget[],
    allowPartial: boolean,
  ): Promise<DeliveryReport> {
    if (!targets.length) {
      return createReport([], true, '没有可发送的目标。')
    }

    const unavailable = targets.filter((target) => (
      !target.bot || target.bot.status !== Universal.Status.ONLINE
    ))
    if (!allowPartial && unavailable.length) {
      const results = targets.map((target) => ({
        target,
        success: false,
        error: target.bot
          ? '其他目标不可用，整次发送已取消'
          : '目标机器人不在线或不存在',
      }))
      return createReport(results, true, '存在不可用目标，已取消本次发送。')
    }

    const unavailableResults: DeliveryResult[] = unavailable.map((target) => ({
      target,
      success: false,
      error: '目标机器人不在线或不存在',
    }))
    const available = targets.filter((target) => (
      !!target.bot && target.bot.status === Universal.Status.ONLINE
    ))
    const sendResults = await Promise.all(available.map(async (target): Promise<DeliveryResult> => {
      try {
        await target.bot!.sendMessage(target.channelId, content)
        return { target, success: true }
      } catch (error) {
        const rendered = formatError(error)
        this.logger.error('推送到 %s 失败：%s', target.label, rendered)
        return { target, success: false, error: '发送失败，请查看插件日志' }
      }
    }))

    return createReport([...unavailableResults, ...sendResults], false)
  }

  private resolveConfiguredTarget(target: TargetConfig): DeliveryTarget {
    const bot = findTargetBot(this.ctx, target)
    const stateKey = getTargetStateKey(target)
    return {
      identity: bot ? getDeliveryIdentity(bot, target.channelId) : `config:${stateKey}`,
      stateKeys: [stateKey],
      label: `${target.platform}:${target.selfId || '*'}:${target.channelId}`,
      channelId: target.channelId,
      bot,
    }
  }
}

export function getTargetStateKey(target: TargetConfig) {
  return [target.platform || '*', target.selfId || '*', target.channelId]
    .map((value) => encodeURIComponent(value))
    .join(':')
}

function createSessionTarget(session: Session): DeliveryTarget {
  const channelId = session.channelId
  if (!channelId) throw new Error('当前会话缺少 channelId')
  return {
    identity: getDeliveryIdentity(session.bot, channelId),
    stateKeys: [],
    label: `current:${session.platform}:${session.selfId}:${channelId}`,
    channelId,
    bot: session.bot,
  }
}

function getDeliveryIdentity(bot: Bot, channelId: string) {
  return JSON.stringify([bot.sid, channelId])
}

function mergeDuplicateTargets(targets: DeliveryTarget[]) {
  const unique = new Map<string, DeliveryTarget>()

  for (const target of targets) {
    const existing = unique.get(target.identity)
    if (!existing) {
      unique.set(target.identity, target)
      continue
    }

    existing.stateKeys = Array.from(new Set([
      ...existing.stateKeys,
      ...target.stateKeys,
    ]))
  }

  return Array.from(unique.values())
}

function findTargetBot(ctx: Context, target: TargetConfig) {
  const bots = Array.from(ctx.bots || [])
  return bots.find((bot) => {
    if (bot.status !== Universal.Status.ONLINE) return false
    if (target.platform && bot.platform !== target.platform) return false
    if (target.selfId && bot.selfId !== target.selfId) return false
    return true
  })
}

function createReport(
  results: DeliveryResult[],
  canceled: boolean,
  reason?: string,
): DeliveryReport {
  return {
    canceled,
    reason,
    results,
    successCount: results.filter((item) => item.success).length,
    failureCount: results.filter((item) => !item.success).length,
  }
}
