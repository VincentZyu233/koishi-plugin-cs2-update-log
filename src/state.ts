import { Context } from 'koishi'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { DeliveryReport } from './delivery'
import type { SteamNewsItem } from './steam'
import { formatError, isNodeError } from './utils/error'
import { resolveStatePath } from './utils/path'

const LOGGER_NAME = 'cs2-update-log'
const STATE_VERSION = 2
const STATE_LIMIT = 1000

interface FailedDeliveryStateEntry {
  item: SteamNewsItem
  targetKeys: string[]
}

interface StateFile {
  version: number
  initialized: boolean
  gids: string[]
  failedDeliveries: Record<string, FailedDeliveryStateEntry>
  updatedAt: string
}

export interface PendingDelivery {
  item: SteamNewsItem
  targetKeys: Set<string>
}

export class StateStore {
  private readonly logger: ReturnType<Context['logger']>
  private readonly statePath: string
  private readonly knownGids = new Set<string>()
  private readonly failedDeliveries = new Map<string, PendingDelivery>()

  private stateInitialized = false
  private loadPromise?: Promise<void>

  constructor(ctx: Context, stateFile: string) {
    this.logger = ctx.logger(LOGGER_NAME)
    this.statePath = resolveStatePath(ctx, stateFile)
  }

  get initialized() {
    return this.stateInitialized
  }

  get isFirstRun() {
    return !this.stateInitialized
      && this.knownGids.size === 0
      && this.failedDeliveries.size === 0
  }

  get knownCount() {
    return this.knownGids.size
  }

  get failedCount() {
    return this.failedDeliveries.size
  }

  load() {
    return this.loadPromise ||= this.read()
  }

  has(gid: string) {
    return this.knownGids.has(gid)
  }

  mark(item: SteamNewsItem | string) {
    const gid = typeof item === 'string' ? item : item.gid
    if (gid) this.knownGids.add(gid)
  }

  markAll(items: Iterable<SteamNewsItem | string>) {
    for (const item of items) this.mark(item)
  }

  getPendingDeliveries(): PendingDelivery[] {
    return Array.from(this.failedDeliveries.values())
      .sort((left, right) => compareNewsOldestFirst(left.item, right.item))
      .map((entry) => ({
        item: entry.item,
        targetKeys: new Set(entry.targetKeys),
      }))
  }

  applyDeliveryReport(item: SteamNewsItem, report: DeliveryReport) {
    const existing = this.failedDeliveries.get(item.gid)
    const targetKeys = new Set(existing?.targetKeys)

    for (const delivery of report.results) {
      for (const stateKey of delivery.target.stateKeys) {
        if (delivery.success) targetKeys.delete(stateKey)
        else targetKeys.add(stateKey)
      }
    }

    if (targetKeys.size) {
      this.failedDeliveries.set(item.gid, { item, targetKeys })
    } else {
      this.failedDeliveries.delete(item.gid)
    }
  }

  async save(recentItems: SteamNewsItem[] = []) {
    try {
      const failedEntries = Array.from(this.failedDeliveries.entries())
        .filter(([, entry]) => entry.targetKeys.size)
        .sort((left, right) => compareNewsOldestFirst(left[1].item, right[1].item))
      const pendingGids = failedEntries.map(([gid]) => gid)
      const pendingSet = new Set(pendingGids)
      const candidates = [
        ...recentItems.map((item) => item.gid).filter((gid) => this.knownGids.has(gid)),
        ...this.knownGids,
      ].filter(Boolean)
      const regularGids = Array.from(new Set(candidates))
        .filter((gid) => !pendingSet.has(gid))
      const regularLimit = Math.max(0, STATE_LIMIT - pendingGids.length)
      const gids = [...pendingGids, ...regularGids.slice(0, regularLimit)]
      const failedDeliveries = Object.fromEntries(failedEntries.map(([gid, entry]) => [
        gid,
        {
          item: entry.item,
          targetKeys: Array.from(entry.targetKeys).sort(),
        },
      ]))
      const state: StateFile = {
        version: STATE_VERSION,
        initialized: true,
        gids,
        failedDeliveries,
        updatedAt: new Date().toISOString(),
      }

      await fs.mkdir(path.dirname(this.statePath), { recursive: true })
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`
      await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await fs.rename(temporaryPath, this.statePath)

      this.knownGids.clear()
      this.markAll(gids)
      this.stateInitialized = true
    } catch (error) {
      this.logger.error('写入 state 文件失败：%s', formatError(error))
      throw error
    }
  }

  private async read() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed)) throw new Error('state root must be an object')

      if (Array.isArray(parsed.gids)) {
        for (const gid of parsed.gids) {
          if (gid != null && String(gid)) this.knownGids.add(String(gid))
        }
      }

      if (isRecord(parsed.failedDeliveries)) {
        for (const [stateGid, value] of Object.entries(parsed.failedDeliveries)) {
          const entry = readFailedDeliveryEntry(stateGid, value)
          if (!entry) continue
          this.failedDeliveries.set(entry.item.gid, entry)
          this.knownGids.add(entry.item.gid)
        }
      }

      this.stateInitialized = parsed.initialized === true
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      this.logger.warn('读取 state 文件失败，将按首次启动处理：%s', formatError(error))
    }
  }
}

function readFailedDeliveryEntry(stateGid: string, value: unknown): PendingDelivery | undefined {
  if (!isRecord(value) || !isRecord(value.item) || !Array.isArray(value.targetKeys)) return
  const gid = String(value.item.gid || stateGid).trim()
  const title = typeof value.item.title === 'string' ? value.item.title : ''
  const content = typeof value.item.content === 'string' ? value.item.content : ''
  const date = Number(value.item.date)
  const targetKeys = new Set(value.targetKeys
    .filter((key): key is string => typeof key === 'string' && !!key))
  if (!gid || !title || !Number.isFinite(date) || !targetKeys.size) return

  return {
    item: {
      gid,
      title,
      content,
      date,
      url: typeof value.item.url === 'string' ? value.item.url : undefined,
      author: typeof value.item.author === 'string' ? value.item.author : undefined,
    },
    targetKeys,
  }
}

function compareNewsOldestFirst(left: SteamNewsItem, right: SteamNewsItem) {
  return left.date - right.date || left.gid.localeCompare(right.gid)
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
