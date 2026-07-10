import { Context, h, Schema, Universal } from 'koishi'
import MarkdownIt from 'markdown-it'
import { XMLParser } from 'fast-xml-parser'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const name = 'cs2-update-log'

export const inject = {
  required: ['http'],
  optional: ['puppeteer'],
}

const APP_ID = 730
const STEAM_FASTLY_RSS_URL = `https://store.fastly.steamstatic.com/feeds/news/app/${APP_ID}/`
const STEAM_STORE_RSS_URL = `https://store.steampowered.com/feeds/news/app/${APP_ID}/`
const STEAM_NEWS_API_URL = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/'
const STATE_LIMIT = 1000
const RSS_LIST_CACHE_TTL_MS = 3 * 1000
const RSS_CACHE_BUCKET_MS = 30 * 1000
const STEAM_REQUEST_TIMEOUT_MS = 8 * 1000
const RUNTIME_CACHE_CLEAR_INTERVAL_MS = 5 * 60 * 1000
const TRANSLATE_TIMEOUT_MS = 90 * 1000
const ASSET_DIR = path.resolve(__dirname, '..', 'assets')
const BRAND_LOGO_PATH = path.join(ASSET_DIR, 'brand-logo.png')
const GITHUB_QRCODE_PATH = path.join(ASSET_DIR, 'github-qrcode.png')

const loggerName = 'cs2-update-log'

type NewsCategory = 'update' | 'announcement'

interface SteamNewsItem {
  gid: string
  title: string
  url?: string
  author?: string
  content: string
  date: number
}

interface RssFeed {
  rss?: {
    channel?: {
      item?: RssItem | RssItem[]
    }
  }
}

interface RssItem {
  title?: XmlText
  description?: XmlText
  link?: XmlText
  guid?: XmlText
  pubDate?: XmlText
}

interface SteamNewsApiResponse {
  appnews?: {
    newsitems?: SteamNewsApiItem[]
  }
}

interface SteamNewsApiItem {
  gid?: string | number
  title?: string
  url?: string
  author?: string
  contents?: string
  date?: number
}

type XmlText = string | number | {
  '#text'?: string | number
}

interface ClassifiedNews {
  item: SteamNewsItem
  category: NewsCategory
}

interface StateFile {
  initialized?: boolean
  gids?: string[]
  updatedAt?: string
}

interface TargetConfig {
  platform: string
  selfId?: string
  channelId: string
  guildId?: string
}

interface TranslateResult {
  title: string
  markdown: string
}

interface RuntimeCache {
  rssFetchedAt: number
  rssItems: SteamNewsItem[]
  newsByGid: Map<string, SteamNewsItem>
  translations: Map<string, TranslateResult>
  cardImages: Map<string, Buffer>
  assetDataUris: Map<string, string>
}

interface CardAssets {
  brandLogoDataUri: string
  githubQrDataUri: string
}

export interface Config {
  interval: number
  count: number
  stateFile: string
  pushOnFirstRun: boolean
  targets: TargetConfig[]
  brandName: string
  siteName: string
  picture: boolean
  appendLink: boolean
  trans: boolean
  translateApiKey: string
  translateApiEndpoint: string
  translateModel: string
  translatePrompt: string
}

export const Config: Schema<Config> = Schema.object({
  interval: Schema.number().min(5).step(1).default(30).description('轮询间隔，单位：秒。'),
  count: Schema.number().min(1).max(100).step(1).default(5).description('每次从 Steam 拉取的新闻数量。'),
  stateFile: Schema.string().default('.koishi-cs2-update-log.json').description('本地 gid 判重文件路径。相对路径会基于 Koishi 启动目录解析。'),
  pushOnFirstRun: Schema.boolean().default(false).description('首次启动时是否推送历史内容。默认关闭，避免刷屏。'),
  targets: Schema.array(Schema.object({
    platform: Schema.string().default('onebot').description('目标平台，例如 onebot。'),
    selfId: Schema.string().description('机器人账号 ID。留空时使用该平台第一个可用机器人。'),
    channelId: Schema.string().required().description('目标频道或 QQ 群号。'),
    guildId: Schema.string().description('可选群组 ID。标准 bot.sendMessage 只使用 channelId，此字段用于记录配置语义。'),
  })).default([]).description('推送目标列表。'),
  brandName: Schema.string().default('CS2 update').description('图片顶部品牌名。'),
  siteName: Schema.string().default('Github仓库').description('图片底部站点名。'),
  picture: Schema.boolean().default(true).description('是否以 Puppeteer 截图长图形式推送。关闭后推送纯文本。'),
  appendLink: Schema.boolean().default(true).description('图片或文本后是否附带 Steam 原文链接。'),
  trans: Schema.boolean().default(false).description('是否启用 AI 翻译。关闭时推送 Steam 返回的原文。'),
  translateApiKey: Schema.string().role('secret').description('AI 翻译 API Key。启用 trans 时必填。'),
  translateApiEndpoint: Schema.string().default('https://api.openai.com/v1/chat/completions').description('OpenAI-compatible Chat Completions 接口地址。'),
  translateModel: Schema.string().default('gpt-4o-mini').description('AI 翻译模型名。'),
  translatePrompt: Schema.string().role('textarea').default('你是一个专业的游戏公告翻译助手。请将 CS2 Steam 官方公告翻译为简体中文，保留 Markdown 结构、更新分区、列表、粗体、行内代码和代码块，不要添加原文没有的解释。').description('AI 翻译系统提示词。'),
})

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const rssParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
})

const updateTitlePattern = /\b(?:Counter-Strike 2 Update|Release Notes)\b/i
const updateSectionPattern = /^\s*\[\s*(MAPS|GAMEPLAY|MISC|AUDIO|ITEMS|WORKSHOP|PREMIER|GRAPHICS|ANIMATION|UI|SOUND|INPUT|NETWORKING|MATCHMAKING|ARMORY|ENGINE|MAP SCRIPTING)\s*\]\s*$/gim
const updateSectionInlinePattern = /\[\s*(?:MAPS|GAMEPLAY|MISC|AUDIO|ITEMS|WORKSHOP|PREMIER|GRAPHICS|ANIMATION|UI|SOUND|INPUT|NETWORKING|MATCHMAKING|ARMORY|ENGINE|MAP SCRIPTING)\s*\]/i
const sectionHeadingPattern = /^\s*\[\s*([A-Z][A-Z0-9 &'/-]{1,48})\s*\]\s*$/gim

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(loggerName)
  const statePath = resolveStatePath(ctx, config.stateFile)
  const knownGids = new Set<string>()
  const cache: RuntimeCache = {
    rssFetchedAt: 0,
    rssItems: [],
    newsByGid: new Map(),
    translations: new Map(),
    cardImages: new Map(),
    assetDataUris: new Map(),
  }
  let stateInitialized = false
  let polling = false
  let appReady = false
  let stateLoadPromise: Promise<void> | undefined
  let initialPollStarted = false

  function clearRuntimeCache(reason: string) {
    cache.rssFetchedAt = 0
    cache.rssItems = []
    cache.newsByGid.clear()
    cache.translations.clear()
    cache.cardImages.clear()
    cache.assetDataUris.clear()
    logger.info('已清理运行时缓存：%s', reason)
  }

  async function loadState() {
    try {
      const raw = await fs.readFile(statePath, 'utf8')
      const parsed = JSON.parse(raw) as StateFile
      for (const gid of parsed.gids || []) {
        if (gid) knownGids.add(String(gid))
      }
      stateInitialized = !!parsed.initialized
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      logger.warn('读取 state 文件失败，将按首次启动处理：%s', formatError(error))
    }
  }

  async function saveState(recentItems: SteamNewsItem[]) {
    try {
      const recentGids = recentItems
        .map((item) => item.gid)
        .filter((gid) => gid && knownGids.has(gid))
      const recentSet = new Set(recentGids)
      const gids = [
        ...recentGids,
        ...Array.from(knownGids).filter((gid) => !recentSet.has(gid)),
      ].slice(0, STATE_LIMIT)

      await fs.mkdir(path.dirname(statePath), { recursive: true })
      await fs.writeFile(statePath, `${JSON.stringify({
        initialized: true,
        gids,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8')

      knownGids.clear()
      for (const gid of gids) knownGids.add(gid)
      stateInitialized = true
    } catch (error) {
      logger.error('写入 state 文件失败：%s', formatError(error))
    }
  }

  async function fetchNews(): Promise<SteamNewsItem[]> {
    try {
      if (cache.rssItems.length && Date.now() - cache.rssFetchedAt < RSS_LIST_CACHE_TTL_MS) {
        logger.debug('使用 RSS 短时缓存：items=%d', cache.rssItems.length)
        return cache.rssItems.slice(0, config.count)
      }

      const cacheBucket = Math.floor(Date.now() / RSS_CACHE_BUCKET_MS)
      const fastlyUrl = `${STEAM_FASTLY_RSS_URL}?l=english&_=${cacheBucket}`
      const apiUrl = `${STEAM_NEWS_API_URL}?appid=${APP_ID}&count=${config.count}&maxlength=0&format=json`

      let items: SteamNewsItem[]
      try {
        items = await Promise.any([
          fetchRssSource('Fastly RSS', fastlyUrl),
          fetchApiSource('Steam Web API', apiUrl),
        ])
      } catch (primaryError) {
        const storeUrl = `${STEAM_STORE_RSS_URL}?l=english&_=${cacheBucket}`
        logger.warn('Fastly RSS 与 Steam Web API 均不可用，回退到 Store RSS：%s', formatAggregateError(primaryError))
        items = await fetchRssSource('Store RSS', storeUrl)
      }

      const cachedItems = items.map((item) => {
        const cached = cache.newsByGid.get(item.gid)
        if (cached && cached.title === item.title && cached.content === item.content && cached.url === item.url && cached.date === item.date) {
          return cached
        }
        cache.newsByGid.set(item.gid, item)
        return item
      })

      cache.rssFetchedAt = Date.now()
      cache.rssItems = cachedItems

      return cachedItems.slice(0, config.count)
    } catch (error) {
      logger.error('拉取 Steam CS2 官方新闻失败：\n%s', formatError(error))
      return []
    }
  }

  async function fetchRssSource(source: string, url: string): Promise<SteamNewsItem[]> {
    const startedAt = Date.now()
    try {
      const xml = await ctx.http.get<string>(url, {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          'User-Agent': 'koishi-plugin-cs2-update-log/2.2',
        },
        responseType: 'text',
        timeout: STEAM_REQUEST_TIMEOUT_MS,
      })

      const parsed = rssParser.parse(xml) as RssFeed
      const rawItems = parsed.rss?.channel?.item
      const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : []

      const parsedItems = items
        .map(parseRssItem)
        .filter((item): item is SteamNewsItem => !!item?.gid && !!item.title)

      if (!parsedItems.length) throw new Error('返回内容中没有有效新闻')
      logger.debug('%s 拉取成功：items=%d duration=%dms', source, parsedItems.length, Date.now() - startedAt)
      return parsedItems
    } catch (error) {
      logger.debug('%s 拉取失败：duration=%dms url=%s\n%s', source, Date.now() - startedAt, url, formatError(error))
      throw new Error(`${source} 拉取失败：${formatError(error)}`)
    }
  }

  async function fetchApiSource(source: string, url: string): Promise<SteamNewsItem[]> {
    const startedAt = Date.now()
    try {
      const response = await ctx.http.get<SteamNewsApiResponse>(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'koishi-plugin-cs2-update-log/2.2',
        },
        timeout: STEAM_REQUEST_TIMEOUT_MS,
      })
      const parsedItems = (response.appnews?.newsitems || [])
        .map(parseSteamApiItem)
        .filter((item): item is SteamNewsItem => !!item?.gid && !!item.title)

      if (!parsedItems.length) throw new Error('返回内容中没有有效新闻')
      logger.debug('%s 拉取成功：items=%d duration=%dms', source, parsedItems.length, Date.now() - startedAt)
      return parsedItems
    } catch (error) {
      logger.debug('%s 拉取失败：duration=%dms url=%s\n%s', source, Date.now() - startedAt, url, formatError(error))
      throw new Error(`${source} 拉取失败：${formatError(error)}`)
    }
  }

  async function pollAndPush(source: 'startup' | 'timer' | 'manual' | 'online'): Promise<number> {
    if (polling) {
      logger.debug('已有轮询任务正在执行，跳过本次 %s。', source)
      return 0
    }

    polling = true
    try {
      const items = await fetchNews()
      if (!items.length) return 0

      const firstRun = !stateInitialized && knownGids.size === 0
      if (firstRun && !config.pushOnFirstRun) {
        for (const item of items) knownGids.add(item.gid)
        await saveState(items)
        logger.info('首次启动已记录 %d 条历史新闻，不推送。', items.length)
        return 0
      }

      const freshItems = items
        .filter((item) => !knownGids.has(item.gid))
        .reverse()

      let pushed = 0
      for (const item of freshItems) {
        const classified = classifyNews(item)
        const delivered = await pushNews(classified)
        if (!delivered) {
          logger.warn('新闻未成功送达，保留 gid 等待重试：gid=%s title=%s', item.gid, item.title)
          continue
        }
        knownGids.add(item.gid)
        pushed += 1
      }

      await saveState(items)
      return pushed
    } catch (error) {
      logger.error('检查并推送 CS2 新闻失败：%s', formatError(error))
      return 0
    } finally {
      polling = false
    }
  }

  async function buildNewsContent(news: ClassifiedNews) {
    const link = getNewsLink(news.item)
    const baseMarkdown = steamContentToMarkdown(news.item.content)
    const translated = await maybeTranslate(news.item.title, baseMarkdown)
    const displayTitle = translated.title || news.item.title
    const displayMarkdown = translated.markdown || baseMarkdown

    return config.picture
      ? await renderOrFallbackText(news, displayTitle, displayMarkdown, link)
      : buildTextMessage(news, displayTitle, displayMarkdown, link)
  }

  async function pushNews(news: ClassifiedNews): Promise<boolean> {
    if (!config.targets.length) {
      logger.warn('未配置推送目标，已跳过：%s', news.item.title)
      return false
    }

    const deliveries = config.targets.map((target) => ({
      target,
      bot: findTargetBot(ctx, target),
    }))
    const unavailable = deliveries.filter(({ bot }) => !bot)
    if (unavailable.length) {
      for (const { target } of unavailable) {
        logger.warn('找不到在线推送机器人 platform=%s selfId=%s', target.platform, target.selfId || '*')
      }
      return false
    }

    const content = await buildNewsContent(news)
    const results = await Promise.all(deliveries.map(async ({ target, bot }) => {
      try {
        if (!bot) return false
        await bot.sendMessage(target.channelId, content)
        return true
      } catch (error) {
        logger.error('推送到 channelId=%s 失败：%s', target.channelId, formatError(error))
        return false
      }
    }))
    return results.every(Boolean)
  }

  function ensureStateLoaded() {
    return stateLoadPromise ||= loadState()
  }

  function allTargetBotsOnline() {
    return !!config.targets.length && config.targets.every((target) => !!findTargetBot(ctx, target))
  }

  async function pollWhenTargetsOnline(source: 'startup' | 'timer' | 'manual' | 'online') {
    if (!appReady) {
      logger.debug('应用尚未 ready，跳过本次 %s 轮询。', source)
      return 0
    }
    await ensureStateLoaded()
    if (!allTargetBotsOnline()) {
      logger.debug('目标机器人尚未全部在线，跳过本次 %s 轮询。', source)
      return 0
    }

    if (!initialPollStarted) {
      initialPollStarted = true
      return pollAndPush('startup')
    }
    return pollAndPush(source)
  }

  async function renderOrFallbackText(news: ClassifiedNews, title: string, bodyMarkdown: string, link: string) {
    const puppeteer = (ctx as Context & { puppeteer?: PuppeteerService }).puppeteer
    if (!puppeteer?.page) {
      logger.warn('已开启 picture，但未检测到 puppeteer 服务，将降级为纯文本推送。')
      return buildTextMessage(news, title, bodyMarkdown, link)
    }

    try {
      const cacheKey = hashCacheKey('card-image', news.item.gid, news.category, config.brandName, config.siteName, title, bodyMarkdown)
      let png = cache.cardImages.get(cacheKey)
      if (!png) {
        png = await renderCard(puppeteer, news, title, bodyMarkdown)
        cache.cardImages.set(cacheKey, png)
      } else {
        logger.debug('使用长图缓存：gid=%s title=%s', news.item.gid, news.item.title)
      }

      const image = h.image(png, 'image/png')
      return config.appendLink ? [image, '\n', link] : image
    } catch (error) {
      logger.error('生成公告长图失败，将降级为纯文本推送：%s', formatError(error))
      return buildTextMessage(news, title, bodyMarkdown, link)
    }
  }

  async function renderCard(puppeteer: PuppeteerService, news: ClassifiedNews, title: string, bodyMarkdown: string): Promise<Buffer> {
    const assets = await loadCardAssets()
    const html = buildCardHtml(news, title, bodyMarkdown, config, assets)
    const page = await puppeteer.page()

    try {
      if (page.setViewport) {
        await page.setViewport({
          width: 780,
          height: 1200,
          deviceScaleFactor: 2,
        })
      }

      await page.setContent(html, {
        waitUntil: 'load',
      })

      const card = await page.$('#card')
      if (!card) throw new Error('card element not found')

      const buffer = await card.screenshot({
        type: 'png',
        omitBackground: true,
      })

      return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  async function maybeTranslate(title: string, bodyMarkdown: string): Promise<TranslateResult> {
    if (!config.trans) return { title, markdown: bodyMarkdown }
    if (!config.translateApiKey) {
      logger.warn('已开启 AI 翻译但未填写 translateApiKey，将推送原文。')
      return { title, markdown: bodyMarkdown }
    }

    const cacheKey = hashCacheKey('translation', config.translateApiEndpoint, config.translateModel, config.translatePrompt, title, bodyMarkdown)
    const cached = cache.translations.get(cacheKey)
    if (cached) {
      logger.debug('使用 AI 翻译缓存：title=%s', title)
      return cached
    }

    try {
      const response = await ctx.http.post<ChatCompletionResponse>(config.translateApiEndpoint, {
        model: config.translateModel,
        messages: [
          {
            role: 'system',
            content: config.translatePrompt,
          },
          {
            role: 'user',
            content: [
              '请输出严格 JSON，不要使用 Markdown 代码块。',
              'JSON 结构为 {"title":"翻译后的标题","markdown":"翻译后的正文 Markdown"}。',
              '保留原文的 Markdown 层级、列表、粗体、行内 code 和代码块。',
              '',
              `标题：${title}`,
              '',
              '正文 Markdown：',
              bodyMarkdown,
            ].join('\n'),
          },
        ],
        temperature: 0.2,
      }, {
        headers: {
          Authorization: `Bearer ${config.translateApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TRANSLATE_TIMEOUT_MS,
      })

      const content = response?.choices?.[0]?.message?.content?.trim()
      if (!content) throw new Error('empty translation response')

      const parsed = parseJsonObject(content) as Partial<TranslateResult>
      const translated = {
        title: parsed.title || title,
        markdown: parsed.markdown || bodyMarkdown,
      }
      cache.translations.set(cacheKey, translated)
      return translated
    } catch (error) {
      logger.error('AI 翻译失败，将推送原文：%s', formatError(error))
      return { title, markdown: bodyMarkdown }
    }
  }

  async function loadCardAssets(): Promise<CardAssets> {
    const [brandLogoDataUri, githubQrDataUri] = await Promise.all([
      loadAssetDataUri('brand-logo', BRAND_LOGO_PATH, 'image/png'),
      loadAssetDataUri('github-qrcode', GITHUB_QRCODE_PATH, 'image/png'),
    ])

    return {
      brandLogoDataUri,
      githubQrDataUri,
    }
  }

  async function loadAssetDataUri(cacheKey: string, filePath: string, mimeType: string) {
    const cached = cache.assetDataUris.get(cacheKey)
    if (cached) return cached

    try {
      const buffer = await fs.readFile(filePath)
      const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`
      cache.assetDataUris.set(cacheKey, dataUri)
      return dataUri
    } catch (error) {
      logger.error('读取卡片资源失败：path=%s\n%s', filePath, formatError(error))
      return ''
    }
  }

  ctx.command('cs2log.check', '查看最近 5 条 CS2 官方公告分类结果')
    .action(async () => {
      const items = await fetchNews()
      if (!items.length) return '没有拉取到 CS2 官方新闻。'

      return items.slice(0, 5)
        .map((item, index) => {
          const category = classifyNews(item).category === 'update' ? '官方更新日志' : '官方公告'
          return [
            `${index + 1}. [${category}] ${item.title}`,
            `发布时间：${formatDate(item.date)}`,
            `gid：${item.gid}`,
            `链接：${getNewsLink(item)}`,
          ].join('\n')
        })
        .join('\n\n')
    })

  ctx.command('cs2log.push', '手动检查并推送新的 CS2 官方公告')
    .action(async () => {
      if (!allTargetBotsOnline()) return '目标机器人尚未在线，暂未执行推送。'
      const pushed = await pollWhenTargetsOnline('manual')
      return pushed ? `已推送 ${pushed} 条新的 CS2 官方新闻。` : '没有发现新的 CS2 官方新闻。'
    })

  ctx.command('cs2log.test', '测试推送最近 2 条 CS2 官方新闻')
    .action(async ({ session }) => {
      if (!session?.bot || !session.channelId) return '测试指令需要在可发送消息的会话中使用。'

      const items = await fetchNews()
      const testItems = items.slice(0, 2).reverse()
      if (!testItems.length) return '没有拉取到可测试推送的 CS2 官方新闻。'

      for (const item of testItems) {
        const content = await buildNewsContent(classifyNews(item))
        await session.bot.sendMessage(session.channelId, content)
      }

      return `已向当前会话触发 ${testItems.length} 条 CS2 官方新闻测试推送。本次测试不会写入 gid 判重 state。`
    })

  ctx.on('ready', async () => {
    appReady = true
    try {
      await pollWhenTargetsOnline('startup')
    } catch (error) {
      logger.error('启动 CS2 新闻轮询失败：%s', formatError(error))
    }
  })

  ctx.on('bot-status-updated', async (bot) => {
    if (bot.status !== Universal.Status.ONLINE) return
    const matchesTarget = config.targets.some((target) => {
      if (target.platform && bot.platform !== target.platform) return false
      if (target.selfId && bot.selfId !== target.selfId) return false
      return true
    })
    if (!matchesTarget) return

    try {
      await pollWhenTargetsOnline('online')
    } catch (error) {
      logger.error('机器人上线后检查 CS2 新闻失败：%s', formatError(error))
    }
  })

  ctx.setInterval(() => {
    void pollWhenTargetsOnline('timer')
  }, Math.max(5, config.interval) * 1000)

  ctx.setInterval(() => {
    clearRuntimeCache('short cache interval')
  }, RUNTIME_CACHE_CLEAR_INTERVAL_MS)
}

function classifyNews(item: SteamNewsItem): ClassifiedNews {
  const body = decodeHtmlEntities(item.content || '')
  const isUpdate = updateTitlePattern.test(item.title)
    || updateSectionPattern.test(body)
    || updateSectionInlinePattern.test(body)

  updateSectionPattern.lastIndex = 0

  return {
    item,
    category: isUpdate ? 'update' : 'announcement',
  }
}

function parseRssItem(item: RssItem): SteamNewsItem | null {
  const title = decodeHtmlEntities(readXmlText(item.title))
  const url = readXmlText(item.link)
  const guid = readXmlText(item.guid)
  const gid = extractNewsGid(guid) || extractNewsGid(url)
  if (!gid || !title) return null

  const pubDate = readXmlText(item.pubDate)
  const dateValue = Date.parse(pubDate)

  return {
    gid,
    title,
    url,
    author: 'BestBcz',
    content: readXmlText(item.description),
    date: Number.isFinite(dateValue) ? Math.floor(dateValue / 1000) : 0,
  }
}

function parseSteamApiItem(item: SteamNewsApiItem): SteamNewsItem | null {
  const gid = String(item.gid || '').trim()
  const title = decodeHtmlEntities(String(item.title || '').trim())
  if (!gid || !title) return null

  return {
    gid,
    title,
    url: String(item.url || '').trim(),
    author: String(item.author || 'Valve').trim(),
    content: String(item.contents || ''),
    date: Number.isFinite(item.date) ? Number(item.date) : 0,
  }
}

function readXmlText(value: XmlText | undefined): string {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return String(value['#text'] ?? '').trim()
}

function extractNewsGid(value: string) {
  return value.match(/\/view\/(\d+)/)?.[1] || ''
}

function steamContentToMarkdown(input: string): string {
  let output = decodeHtmlEntities(input || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\([\[\]])/g, '$1')

  output = output
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<div\b[^>]*class=["'][^"']*bb_h1[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, (_, text) => `\n# ${text.trim()}\n`)
    .replace(/<div\b[^>]*class=["'][^"']*bb_h2[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, (_, text) => `\n## ${text.trim()}\n`)
    .replace(/<div\b[^>]*class=["'][^"']*bb_h3[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, (_, text) => `\n### ${text.trim()}\n`)
    .replace(/<div\b[^>]*class=["'][^"']*bb_h[45][^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, (_, text) => `\n### ${text.trim()}\n`)
    .replace(/<p\b[^>]*class=["'][^"']*bb_paragraph[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi, (_, text) => `\n${text.trim()}\n`)
    .replace(/<li\b[^>]*>\s*/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`)
    .replace(/<[^>]+>/g, '')
    .replace(/\[h1\]([\s\S]*?)\[\/h1\]/gi, (_, text) => `\n# ${text.trim()}\n`)
    .replace(/\[h2\]([\s\S]*?)\[\/h2\]/gi, (_, text) => `\n## ${text.trim()}\n`)
    .replace(/\[h3\]([\s\S]*?)\[\/h3\]/gi, (_, text) => `\n### ${text.trim()}\n`)
    .replace(/\[h[45]\]([\s\S]*?)\[\/h[45]\]/gi, (_, text) => `\n### ${text.trim()}\n`)
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '**$1**')
    .replace(/\[strong\]([\s\S]*?)\[\/strong\]/gi, '**$1**')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '*$1*')
    .replace(/\[em\]([\s\S]*?)\[\/em\]/gi, '*$1*')
    .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '$1')
    .replace(/\[strike\]([\s\S]*?)\[\/strike\]/gi, '~~$1~~')
    .replace(/\[code\]([\s\S]*?)\[\/code\]/gi, (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`)
    .replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, (_, quote) => quote.split('\n').map((line: string) => `> ${line}`).join('\n'))
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, '[$2]($1)')
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '<$1>')
    .replace(/\[img\]([\s\S]*?)\[\/img\]/gi, '')
    .replace(/\[previewyoutube=[^\]]+\]([\s\S]*?)\[\/previewyoutube\]/gi, '')
    .replace(/\[list\]|\[\/list\]|\[olist\]|\[\/olist\]/gi, '\n')
    .replace(/^\s*\[\*\]\s*/gim, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<\/?p>/gi, '\n')

  output = output.replace(sectionHeadingPattern, (_, section) => `\n## [${String(section).toUpperCase()}]\n`)
  sectionHeadingPattern.lastIndex = 0

  return output
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function hashCacheKey(...parts: string[]) {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function buildTextMessage(news: ClassifiedNews, title: string, bodyMarkdown: string, link: string) {
  const categoryName = news.category === 'update' ? 'CS2 官方更新日志' : 'CS2 官方公告'
  const parts = [
    `【${categoryName}】`,
    title,
    '',
    truncateText(stripMarkdown(bodyMarkdown), 1800),
    '',
    `发布时间：${formatDate(news.item.date)}`,
  ]

  if (news.item.author) parts.push(`作者：${news.item.author}`)
  if (link) parts.push(`原文：${link}`)

  return parts.join('\n')
}

function buildCardHtml(news: ClassifiedNews, title: string, bodyMarkdown: string, config: Config, assets: CardAssets): string {
  const categoryName = news.category === 'update' ? 'CS2 官方更新日志' : 'CS2 官方公告'
  const categoryTag = news.category === 'update' ? 'UPDATE LOG' : 'ANNOUNCEMENT'
  const rendered = markdown.render(bodyMarkdown)
  const publishedAt = formatDate(news.item.date)
  const author = news.item.author || 'Valve'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
* {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  padding: 0;
  width: 780px;
  min-height: 100%;
  background: transparent;
  font-family: Inter, "HarmonyOS Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif;
  color: #f7f9ff;
}
body {
  padding: 24px;
}
#card {
  width: 732px;
  overflow: hidden;
  border-radius: 0;
  background:
    radial-gradient(circle at 88% 6%, rgba(58, 118, 255, 0.16), transparent 28%),
    radial-gradient(circle at 88% 92%, rgba(132, 66, 210, 0.16), transparent 30%),
    linear-gradient(180deg, #0a1224 0%, #070b15 54%, #070714 100%);
  border: 1px solid rgba(149, 177, 255, 0.11);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  padding: 44px 48px 42px;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 28px;
  border-bottom: 1px solid rgba(170, 193, 255, 0.14);
}
.brand {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.avatar {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: linear-gradient(145deg, #1f2b44, #0e1424);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 0 0 5px rgba(255, 255, 255, 0.03);
  font-size: 26px;
  overflow: hidden;
}
.avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.brand-title {
  font-size: 21px;
  font-weight: 800;
  letter-spacing: 0;
  line-height: 1.1;
}
.brand-subtitle,
.category-subtitle {
  margin-top: 5px;
  color: #8f9bb6;
  font-size: 14px;
  line-height: 1.35;
}
.category {
  text-align: right;
  flex: 0 0 auto;
}
.category-title {
  color: #54a8ff;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0;
}
.headline {
  margin: 42px 0 28px;
  font-size: 34px;
  line-height: 1.22;
  font-weight: 900;
  letter-spacing: 0;
  color: #f8fbff;
}
.type-label {
  display: inline-flex;
  align-items: center;
  height: 28px;
  margin-bottom: 18px;
  padding: 0 11px;
  border-radius: 6px;
  background: rgba(74, 139, 255, 0.15);
  color: #8cbfff;
  border: 1px solid rgba(103, 159, 255, 0.22);
  font-size: 13px;
  font-weight: 700;
}
.content {
  color: #d9e1f2;
  font-size: 21px;
  line-height: 1.72;
  word-break: break-word;
}
.content h1,
.content h2,
.content h3 {
  margin: 34px 0 14px;
  line-height: 1.32;
  color: #ffffff;
  font-weight: 850;
  letter-spacing: 0;
}
.content h1 {
  font-size: 28px;
}
.content h2 {
  font-size: 25px;
}
.content h3 {
  font-size: 22px;
}
.content p {
  margin: 0 0 18px;
}
.content strong {
  color: #ffffff;
  font-weight: 850;
}
.content a {
  color: #7bb6ff;
  text-decoration: none;
}
.content ul,
.content ol {
  margin: 8px 0 20px;
  padding-left: 28px;
}
.content li {
  margin: 8px 0;
}
.content code {
  display: inline-block;
  max-width: 100%;
  vertical-align: baseline;
  padding: 2px 8px 4px;
  border-radius: 5px;
  background: rgba(67, 96, 144, 0.56);
  color: #8bc5ff;
  font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
  font-size: 0.78em;
  line-height: 1.45;
}
.content pre {
  margin: 22px 0 24px;
  padding: 22px 24px;
  border-radius: 8px;
  background: rgba(3, 8, 19, 0.72);
  border: 1px solid rgba(142, 171, 234, 0.18);
  overflow: hidden;
}
.content pre code {
  display: block;
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: #d7e5ff;
  font-size: 16px;
  line-height: 1.65;
  white-space: pre-wrap;
}
.footer {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 28px;
  margin-top: 42px;
  padding-top: 28px;
  border-top: 1px solid rgba(170, 193, 255, 0.14);
}
.published-label {
  color: #70809e;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.8px;
}
.published-time {
  margin-top: 8px;
  font-size: 29px;
  line-height: 1.1;
  font-weight: 900;
  color: #ffffff;
}
.site-wrap {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  min-width: 230px;
}
.site {
  text-align: right;
  min-width: 160px;
}
.site-name {
  font-size: 17px;
  font-weight: 850;
  color: #ffffff;
}
.author {
  margin-top: 6px;
  color: #78b7ff;
  font-size: 14px;
}
.qr-code {
  display: block;
  width: 64px;
  height: 64px;
  flex: 0 0 auto;
  border-radius: 5px;
  background: #ffffff;
  object-fit: cover;
}
</style>
</head>
<body>
  <article id="card">
    <header class="topbar">
      <div class="brand">
        <div class="avatar">${assets.brandLogoDataUri ? `<img src="${assets.brandLogoDataUri}" alt="">` : 'CS'}</div>
        <div>
          <div class="brand-title">${escapeHtml(config.brandName)}</div>
          <div class="brand-subtitle">CS2 更新日志工具</div>
        </div>
      </div>
      <div class="category">
        <div class="category-title">${categoryTag}</div>
        <div class="category-subtitle">${escapeHtml(categoryName)}</div>
      </div>
    </header>
    <main>
      <h1 class="headline">${escapeHtml(title)}</h1>
      <div class="type-label">${escapeHtml(categoryName)}</div>
      <section class="content">${rendered}</section>
    </main>
    <footer class="footer">
      <div>
        <div class="published-label">PUBLISHED AT</div>
        <div class="published-time">${escapeHtml(publishedAt)}</div>
      </div>
      <div class="site-wrap">
        <div class="site">
          <div class="site-name">${escapeHtml(config.siteName)}</div>
          <div class="author">${escapeHtml(author)}</div>
        </div>
        ${assets.githubQrDataUri ? `<img class="qr-code" src="${assets.githubQrDataUri}" alt="">` : ''}
      </div>
    </footer>
  </article>
</body>
</html>`
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

function resolveStatePath(ctx: Context, stateFile: string) {
  if (path.isAbsolute(stateFile)) return stateFile
  const baseDir = typeof ctx.baseDir === 'string' ? ctx.baseDir : process.cwd()
  return path.resolve(baseDir, stateFile)
}

function getNewsLink(item: SteamNewsItem) {
  return item.url || `https://store.steampowered.com/news/app/${APP_ID}/view/${item.gid}`
}

function formatDate(timestamp: number) {
  if (!timestamp) return '未知'
  const date = new Date(timestamp * 1000)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return [
    date.getFullYear(),
    '/',
    pad(date.getMonth() + 1),
    '/',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('')
}

function stripMarkdown(input: string) {
  return input
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .trim()
}

function truncateText(input: string, maxLength: number) {
  if (input.length <= maxLength) return input
  return `${input.slice(0, maxLength).trimEnd()}\n...`
}

function decodeHtmlEntities(input: string) {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    const lower = String(code).toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return '\''
    if (lower === 'nbsp') return ' '
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
    return entity
  })
}

function escapeHtml(input: string) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseJsonObject(input: string) {
  const cleaned = input
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1))
    }
    throw new Error('translation response is not valid JSON')
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error
}

function formatError(error: unknown) {
  const lines: string[] = []
  appendErrorDetails(lines, error)
  return lines.join('\n')
}

function formatAggregateError(error: unknown) {
  if (error instanceof AggregateError) {
    return error.errors.map((item) => formatError(item)).join(' | ')
  }
  return formatError(error)
}

function appendErrorDetails(lines: string[], error: unknown, label = 'error', depth = 0, seen = new Set<unknown>()) {
  if (error == null || typeof error !== 'object') {
    lines.push(`${label}: ${String(error)}`)
    return
  }

  if (seen.has(error)) {
    lines.push(`${label}: [Circular]`)
    return
  }

  seen.add(error)
  const record = error as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : error instanceof Error ? error.name : 'Error'
  const message = typeof record.message === 'string' ? record.message : String(error)
  lines.push(`${label}: ${name}: ${message}`)

  const details = collectErrorDetails(record)
  if (details.length) lines.push(`${label} details: ${details.join(', ')}`)

  const stack = typeof record.stack === 'string' ? record.stack : ''
  const stackLines = stack.split(/\r?\n/).slice(1, 7).map((line) => line.trim()).filter(Boolean)
  if (stackLines.length) lines.push(`${label} stack:\n  ${stackLines.join('\n  ')}`)

  appendNestedObjectDetails(lines, record, 'request', label)
  appendNestedObjectDetails(lines, record, 'response', label)

  const cause = record.cause
  if (cause !== undefined && depth < 5) {
    appendErrorDetails(lines, cause, `${label}.cause`, depth + 1, seen)
  }
}

function collectErrorDetails(record: Record<string, unknown>) {
  const keys = [
    'code',
    'errno',
    'type',
    'syscall',
    'hostname',
    'host',
    'address',
    'port',
    'method',
    'url',
    'status',
    'statusCode',
    'statusText',
  ]

  const details: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (value == null) continue
    const rendered = renderLogValue(value)
    if (rendered) details.push(`${key}=${rendered}`)
  }

  return details
}

function appendNestedObjectDetails(lines: string[], record: Record<string, unknown>, key: string, label: string) {
  const value = record[key]
  if (!value || typeof value !== 'object') return

  const details = collectErrorDetails(value as Record<string, unknown>)
  if (details.length) lines.push(`${label}.${key} details: ${details.join(', ')}`)
}

function renderLogValue(value: unknown) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return undefined
}

interface PuppeteerService {
  page(): Promise<PuppeteerPage>
}

interface PuppeteerPage {
  setViewport?(viewport: {
    width: number
    height: number
    deviceScaleFactor?: number
  }): Promise<void>
  setContent(html: string, options?: Record<string, unknown>): Promise<void>
  $(selector: string): Promise<PuppeteerElement | null>
  close(): Promise<void>
}

interface PuppeteerElement {
  screenshot(options?: Record<string, unknown>): Promise<Buffer | Uint8Array>
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}
