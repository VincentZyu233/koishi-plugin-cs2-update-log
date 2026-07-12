import { Context } from 'koishi'
import { XMLParser } from 'fast-xml-parser'
import { formatAggregateError, formatError } from './utils/error'

const APP_ID = 730
const STEAM_FASTLY_RSS_URL = `https://store.fastly.steamstatic.com/feeds/news/app/${APP_ID}/`
const STEAM_STORE_RSS_URL = `https://store.steampowered.com/feeds/news/app/${APP_ID}/`
const STEAM_NEWS_API_URL = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/'
const RSS_LIST_CACHE_TTL_MS = 3 * 1000
const RSS_CACHE_BUCKET_MS = 30 * 1000
const STEAM_REQUEST_TIMEOUT_MS = 8 * 1000
const LOGGER_NAME = 'cs2-update-log'

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

export type NewsCategory = 'update' | 'announcement'

export interface SteamNewsItem {
  gid: string
  title: string
  url?: string
  author?: string
  content: string
  date: number
}

export interface ClassifiedNews {
  item: SteamNewsItem
  category: NewsCategory
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

export class SteamNewsClient {
  private readonly logger = this.ctx.logger(LOGGER_NAME)
  private rssFetchedAt = 0
  private rssItems: SteamNewsItem[] = []
  private readonly newsByGid = new Map<string, SteamNewsItem>()

  constructor(
    private readonly ctx: Context,
    private readonly getCount: () => number,
  ) {}

  async fetchNews(): Promise<SteamNewsItem[]> {
    try {
      if (this.rssItems.length && Date.now() - this.rssFetchedAt < RSS_LIST_CACHE_TTL_MS) {
        this.logger.debug('使用 RSS 短时缓存：items=%d', this.rssItems.length)
        return this.rssItems.slice(0, this.getCount())
      }

      const cacheBucket = Math.floor(Date.now() / RSS_CACHE_BUCKET_MS)
      const fastlyUrl = `${STEAM_FASTLY_RSS_URL}?l=english&_=${cacheBucket}`
      const apiUrl = `${STEAM_NEWS_API_URL}?appid=${APP_ID}&count=${this.getCount()}&maxlength=0&format=json`

      let items: SteamNewsItem[]
      try {
        items = await Promise.any([
          this.fetchRssSource('Fastly RSS', fastlyUrl),
          this.fetchApiSource('Steam Web API', apiUrl),
        ])
      } catch (primaryError) {
        const storeUrl = `${STEAM_STORE_RSS_URL}?l=english&_=${cacheBucket}`
        this.logger.warn('Fastly RSS 与 Steam Web API 均不可用，回退到 Store RSS：%s', formatAggregateError(primaryError))
        items = await this.fetchRssSource('Store RSS', storeUrl)
      }

      const cachedItems = items.map((item) => {
        const cached = this.newsByGid.get(item.gid)
        if (cached && cached.title === item.title && cached.content === item.content && cached.url === item.url && cached.date === item.date) {
          return cached
        }
        this.newsByGid.set(item.gid, item)
        return item
      })

      this.rssFetchedAt = Date.now()
      this.rssItems = cachedItems

      return cachedItems.slice(0, this.getCount())
    } catch (error) {
      this.logger.error('拉取 Steam CS2 官方新闻失败：\n%s', formatError(error))
      return []
    }
  }

  clearCache(): void {
    this.rssFetchedAt = 0
    this.rssItems = []
    this.newsByGid.clear()
  }

  private async fetchRssSource(source: string, url: string): Promise<SteamNewsItem[]> {
    const startedAt = Date.now()
    try {
      const xml = await this.ctx.http.get<string>(url, {
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
      this.logger.debug('%s 拉取成功：items=%d duration=%dms', source, parsedItems.length, Date.now() - startedAt)
      return parsedItems
    } catch (error) {
      this.logger.debug('%s 拉取失败：duration=%dms url=%s\n%s', source, Date.now() - startedAt, url, formatError(error))
      throw new Error(`${source} 拉取失败：${formatError(error)}`)
    }
  }

  private async fetchApiSource(source: string, url: string): Promise<SteamNewsItem[]> {
    const startedAt = Date.now()
    try {
      const response = await this.ctx.http.get<SteamNewsApiResponse>(url, {
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
      this.logger.debug('%s 拉取成功：items=%d duration=%dms', source, parsedItems.length, Date.now() - startedAt)
      return parsedItems
    } catch (error) {
      this.logger.debug('%s 拉取失败：duration=%dms url=%s\n%s', source, Date.now() - startedAt, url, formatError(error))
      throw new Error(`${source} 拉取失败：${formatError(error)}`)
    }
  }
}

export function classifyNews(item: SteamNewsItem): ClassifiedNews {
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

export function steamContentToMarkdown(input: string): string {
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

export function getNewsLink(item: SteamNewsItem) {
  return item.url || `https://store.steampowered.com/news/app/${APP_ID}/view/${item.gid}`
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
