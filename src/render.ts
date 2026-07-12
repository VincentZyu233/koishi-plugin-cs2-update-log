import { Context, h } from 'koishi'
import type { Fragment } from 'koishi'
import MarkdownIt from 'markdown-it'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { Config } from './config'
import { FontManager, LXGW_WENKAI_FAMILY } from './font'
import { ClassifiedNews } from './steam'
import { hashCacheKey } from './utils/cache'
import { formatDate } from './utils/date'
import { formatError } from './utils/error'
import { escapeHtml } from './utils/html'

const ASSET_DIR = path.resolve(__dirname, '..', 'assets')
const BRAND_LOGO_PATH = path.join(ASSET_DIR, 'brand-logo.png')
const GITHUB_QRCODE_PATH = path.join(ASSET_DIR, 'github-qrcode.png')
const FONT_NOTICE = 'LXGW 字体不可用，本次图片已使用系统默认字体，请检查网络或 fontPath。'
const TEXT_NOTICE = '图片渲染不可用，本次已降级为纯文本，请检查 Puppeteer 与插件日志。'

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
}).disable('image')

interface CardAssets {
  brandLogoDataUri: string
  githubQrDataUri: string
}

export interface RenderResult {
  content: Fragment
  notice?: string
}

export class NewsRenderer {
  private readonly logger = this.ctx.logger('cs2-update-log')
  private readonly cardImages = new Map<string, Buffer>()
  private readonly assetDataUris = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly font: FontManager,
  ) {}

  clearCache(): void {
    this.cardImages.clear()
    this.assetDataUris.clear()
  }

  async renderOrFallbackText(news: ClassifiedNews, title: string, bodyMarkdown: string, link: string): Promise<RenderResult> {
    const fallbackText = buildTextMessage(news, title, bodyMarkdown, link)
    if (!this.config.picture) return { content: fallbackText }

    const puppeteer = (this.ctx as Context & { puppeteer?: PuppeteerService }).puppeteer
    if (!puppeteer?.page) {
      this.logger.warn('已开启 picture，但未检测到 puppeteer 服务，将降级为纯文本推送。')
      return { content: fallbackText, notice: TEXT_NOTICE }
    }

    const fontBase64 = await this.font.getBase64OrEmpty()
    const fontFallback = !fontBase64
    try {
      const cacheKey = hashCacheKey(
        'card-image',
        news.item.gid,
        news.category,
        this.config.brandName,
        this.config.siteName,
        fontFallback ? 'system-font' : this.font.fontPath,
        title,
        bodyMarkdown,
      )
      let png = this.cardImages.get(cacheKey)
      if (!png) {
        png = await this.renderCard(puppeteer, news, title, bodyMarkdown, fontBase64)
        this.cardImages.set(cacheKey, png)
      } else {
        this.logger.debug('使用长图缓存：gid=%s title=%s', news.item.gid, news.item.title)
      }

      const image = h.image(png, 'image/png')
      return { content: this.config.appendLink ? [image, '\n', link] : image, notice: fontFallback ? FONT_NOTICE : undefined }
    } catch (error) {
      this.logger.error('生成公告长图失败，将降级为纯文本推送：%s', formatError(error))
      return { content: fallbackText, notice: TEXT_NOTICE }
    }
  }

  private async renderCard(
    puppeteer: PuppeteerService,
    news: ClassifiedNews,
    title: string,
    bodyMarkdown: string,
    fontBase64: string,
  ): Promise<Buffer> {
    const assets = await this.loadCardAssets()
    const html = buildCardHtml(news, title, bodyMarkdown, this.config, assets, fontBase64)
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
      if (page.evaluate) await page.evaluate(async () => { await document.fonts?.ready })

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

  private async loadCardAssets(): Promise<CardAssets> {
    const [brandLogoDataUri, githubQrDataUri] = await Promise.all([
      this.loadAssetDataUri('brand-logo', BRAND_LOGO_PATH, 'image/png'),
      this.loadAssetDataUri('github-qrcode', GITHUB_QRCODE_PATH, 'image/png'),
    ])

    return {
      brandLogoDataUri,
      githubQrDataUri,
    }
  }

  private async loadAssetDataUri(cacheKey: string, filePath: string, mimeType: string) {
    const cached = this.assetDataUris.get(cacheKey)
    if (cached) return cached

    try {
      const buffer = await fs.readFile(filePath)
      const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`
      this.assetDataUris.set(cacheKey, dataUri)
      return dataUri
    } catch (error) {
      this.logger.error('读取卡片资源失败：path=%s\n%s', filePath, formatError(error))
      return ''
    }
  }
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

function buildCardHtml(news: ClassifiedNews, title: string, bodyMarkdown: string, config: Config, assets: CardAssets, fontBase64: string): string {
  const categoryName = news.category === 'update' ? 'CS2 官方更新日志' : 'CS2 官方公告'
  const categoryTag = news.category === 'update' ? 'UPDATE LOG' : 'ANNOUNCEMENT'
  const rendered = markdown.render(bodyMarkdown)
  const publishedAt = formatDate(news.item.date)
  const author = news.item.author || 'BestBcz'
  const fontFace = fontBase64 ? `@font-face { font-family: "${LXGW_WENKAI_FAMILY}"; src: url(data:font/truetype;charset=utf-8;base64,${fontBase64}) format("truetype"); font-display: block; }` : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
${fontFace}
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
  font-family: "${LXGW_WENKAI_FAMILY}", Inter, "HarmonyOS Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif;
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
  evaluate?<T>(pageFunction: () => T | Promise<T>): Promise<T>
  $(selector: string): Promise<PuppeteerElement | null>
  close(): Promise<void>
}

interface PuppeteerElement {
  screenshot(options?: Record<string, unknown>): Promise<Buffer | Uint8Array>
}
