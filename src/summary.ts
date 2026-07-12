import { Context, h } from 'koishi'
import MarkdownIt from 'markdown-it'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { Config } from './config'
import { FontManager, LXGW_WENKAI_FAMILY } from './font'
import type { RenderResult } from './render'
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

export interface SummarySource {
  title: string
  date: number
  link: string
}

interface CardAssets {
  brandLogoDataUri: string
  githubQrDataUri: string
}

export class SummaryRenderer {
  private readonly logger: ReturnType<Context['logger']>
  private readonly summaryImages = new Map<string, Buffer>()
  private readonly assetDataUris = new Map<string, string>()

  constructor(private readonly ctx: Context, private readonly config: Config, private readonly font: FontManager) {
    this.logger = ctx.logger('cs2-update-log')
  }

  clearCache(): void {
    this.summaryImages.clear()
    this.assetDataUris.clear()
  }

  async renderOrFallbackText(summaryMarkdown: string, sources: SummarySource[]): Promise<RenderResult> {
    const fallbackText = buildTextMessage(summaryMarkdown, sources)
    if (!this.config.picture) return { content: fallbackText }

    const puppeteer = (this.ctx as Context & { puppeteer?: PuppeteerService }).puppeteer
    if (!puppeteer?.page) {
      this.logger.warn('已开启 picture，但未检测到 puppeteer 服务，AI 摘要将降级为纯文本。')
      return { content: fallbackText, notice: TEXT_NOTICE }
    }

    const fontBase64 = await this.font.getBase64OrEmpty()
    const fontFallback = !fontBase64
    try {
      const cacheKey = hashCacheKey(
        'summary-image',
        this.config.brandName,
        this.config.siteName,
        fontFallback ? 'system-font' : this.font.fontPath,
        summaryMarkdown,
        JSON.stringify(sources),
      )
      let png = this.summaryImages.get(cacheKey)
      if (!png) {
        png = await this.renderCard(puppeteer, summaryMarkdown, sources, fontBase64)
        this.summaryImages.set(cacheKey, png)
      } else {
        this.logger.debug('使用 AI 摘要长图缓存：sources=%s', sources.length)
      }

      const image = h.image(png, 'image/png')
      const sourceList = buildSourceList(sources)
      return { content: this.config.appendLink && sourceList ? [image, '\n', sourceList] : image, notice: fontFallback ? FONT_NOTICE : undefined }
    } catch (error) {
      this.logger.error('生成 AI 摘要长图失败，将降级为纯文本：%s', formatError(error))
      return { content: fallbackText, notice: TEXT_NOTICE }
    }
  }

  private async renderCard(puppeteer: PuppeteerService, summaryMarkdown: string, sources: SummarySource[], fontBase64: string): Promise<Buffer> {
    const assets = await this.loadCardAssets()
    const html = buildCardHtml(summaryMarkdown, sources, this.config, assets, fontBase64)
    const page = await puppeteer.page()

    try {
      if (page.setViewport) {
        await page.setViewport({
          width: 780,
          height: 1400,
          deviceScaleFactor: 2,
        })
      }

      await page.setContent(html, { waitUntil: 'load' })
      if (page.evaluate) await page.evaluate(async () => { await document.fonts?.ready })

      const card = await page.$('#card')
      if (!card) throw new Error('summary card element not found')

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

    return { brandLogoDataUri, githubQrDataUri }
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
      this.logger.error('读取摘要卡片资源失败：path=%s\n%s', filePath, formatError(error))
      return ''
    }
  }
}

function buildTextMessage(summaryMarkdown: string, sources: SummarySource[]) {
  const summary = summaryMarkdown.trim()
  const sourceList = buildSourceList(sources)
  return [summary, sourceList].filter(Boolean).join('\n\n---\n\n')
}

function buildSourceList(sources: SummarySource[]) {
  if (!sources.length) return ''

  const items = sources.map((source, index) => [
    `${index + 1}. ${source.title}`,
    `   - ${formatDate(source.date)}`,
    `   - ${source.link}`,
  ].join('\n'))

  return ['## SOURCES', ...items].join('\n')
}

function buildCardHtml(summaryMarkdown: string, sources: SummarySource[], config: Config, assets: CardAssets, fontBase64: string): string {
  const renderedSummary = markdown.render(summaryMarkdown.trim())
  const generatedAt = formatDate(Math.floor(Date.now() / 1000))
  const fontFace = fontBase64 ? `@font-face { font-family: "${LXGW_WENKAI_FAMILY}"; src: url(data:font/truetype;charset=utf-8;base64,${fontBase64}) format("truetype"); font-display: block; }` : ''
  const renderedSources = sources.map((source, index) => `
    <section class="source-item">
      <div class="source-index">${String(index + 1).padStart(2, '0')}</div>
      <div class="source-main">
        <div class="source-title">${escapeHtml(source.title)}</div>
        <div class="source-date">${escapeHtml(formatDate(source.date))}</div>
        <div class="source-link">${escapeHtml(source.link)}</div>
      </div>
    </section>`).join('')

  return `<!doctype html>
<html lang="en">
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
  border: 1px solid rgba(149, 177, 255, 0.13);
  background:
    radial-gradient(circle at 88% 5%, rgba(58, 118, 255, 0.18), transparent 27%),
    radial-gradient(circle at 10% 94%, rgba(38, 166, 135, 0.12), transparent 29%),
    linear-gradient(180deg, #0a1224 0%, #070b15 55%, #070714 100%);
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
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 50%;
  background: #101a2f;
  font-size: 24px;
  font-weight: 800;
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
  line-height: 1.1;
}
.brand-subtitle,
.digest-subtitle {
  margin-top: 5px;
  color: #8f9bb6;
  font-size: 14px;
  line-height: 1.35;
}
.digest-label {
  flex: 0 0 auto;
  text-align: right;
}
.digest-title {
  color: #63b2ff;
  font-size: 15px;
  font-weight: 800;
}
.headline {
  margin: 42px 0 12px;
  color: #f8fbff;
  font-size: 38px;
  font-weight: 900;
  line-height: 1.16;
}
.headline-note {
  margin-bottom: 32px;
  color: #8896b3;
  font-size: 15px;
}
.content {
  color: #d9e1f2;
  font-size: 20px;
  line-height: 1.72;
  overflow-wrap: anywhere;
}
.content h1,
.content h2,
.content h3 {
  margin: 32px 0 14px;
  color: #ffffff;
  font-weight: 850;
  line-height: 1.32;
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
.content blockquote {
  margin: 20px 0;
  padding: 2px 0 2px 18px;
  border-left: 3px solid #4b9cff;
  color: #aebbd3;
}
.content code {
  padding: 2px 7px 4px;
  border-radius: 5px;
  background: rgba(67, 96, 144, 0.56);
  color: #8bc5ff;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 0.8em;
}
.content pre {
  margin: 22px 0 24px;
  padding: 20px 22px;
  overflow: hidden;
  border: 1px solid rgba(142, 171, 234, 0.18);
  border-radius: 8px;
  background: rgba(3, 8, 19, 0.72);
}
.content pre code {
  padding: 0;
  background: transparent;
  color: #d7e5ff;
  font-size: 16px;
  line-height: 1.65;
  white-space: pre-wrap;
}
.sources {
  margin-top: 42px;
  padding-top: 30px;
  border-top: 1px solid rgba(170, 193, 255, 0.14);
}
.section-label {
  margin-bottom: 18px;
  color: #73b8ff;
  font-size: 13px;
  font-weight: 850;
}
.source-item {
  display: flex;
  gap: 16px;
  padding: 15px 0;
  border-top: 1px solid rgba(170, 193, 255, 0.09);
}
.source-item:first-of-type {
  border-top: 0;
}
.source-index {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border: 1px solid rgba(99, 178, 255, 0.26);
  border-radius: 6px;
  background: rgba(74, 139, 255, 0.12);
  color: #8dc5ff;
  font-size: 12px;
  font-weight: 850;
}
.source-main {
  min-width: 0;
}
.source-title {
  color: #f1f5ff;
  font-size: 17px;
  font-weight: 750;
  line-height: 1.4;
}
.source-date {
  margin-top: 5px;
  color: #8e9bb4;
  font-size: 13px;
}
.source-link {
  margin-top: 6px;
  color: #66abec;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.footer {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 28px;
  margin-top: 34px;
  padding-top: 26px;
  border-top: 1px solid rgba(170, 193, 255, 0.14);
}
.generated-label {
  color: #70809e;
  font-size: 11px;
  font-weight: 800;
}
.generated-time {
  margin-top: 8px;
  color: #ffffff;
  font-size: 24px;
  font-weight: 900;
}
.site-wrap {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
}
.site {
  max-width: 190px;
  color: #ffffff;
  font-size: 16px;
  font-weight: 800;
  overflow-wrap: anywhere;
  text-align: right;
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
          <div class="brand-subtitle">OFFICIAL STEAM NEWS</div>
        </div>
      </div>
      <div class="digest-label">
        <div class="digest-title">AI SUMMARY</div>
        <div class="digest-subtitle">${sources.length} SOURCES</div>
      </div>
    </header>
    <main>
      <h1 class="headline">CS2 NEWS DIGEST</h1>
      <div class="headline-note">TRANSLATED AND SUMMARIZED BY LLM</div>
      <section class="content">${renderedSummary}</section>
      ${renderedSources ? `<section class="sources"><div class="section-label">SOURCES</div>${renderedSources}</section>` : ''}
    </main>
    <footer class="footer">
      <div>
        <div class="generated-label">GENERATED AT</div>
        <div class="generated-time">${escapeHtml(generatedAt)}</div>
      </div>
      <div class="site-wrap">
        <div class="site">${escapeHtml(config.siteName)}</div>
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
