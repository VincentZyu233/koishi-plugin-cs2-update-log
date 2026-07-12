import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Context } from 'koishi'

export const LXGW_WENKAI_FILE_NAME = 'LXGWWenKaiMono-Regular.ttf'
export const LXGW_WENKAI_FAMILY = 'LXGW WenKai Mono'

const GITEE_RELEASE_BASE = 'https://gitee.com/vincent-zyu/koishi-plugin-awa-quote-image/releases/download/fonts'
const GITHUB_RELEASE_BASE = 'https://github.com/VincentZyuApps/koishi-plugin-awa-quote-image/releases/download/fonts'

export const LXGW_WENKAI_URL = `${GITEE_RELEASE_BASE}/${LXGW_WENKAI_FILE_NAME}`
export const LXGW_WENKAI_GITHUB_URL = `${GITHUB_RELEASE_BASE}/${LXGW_WENKAI_FILE_NAME}`

interface FontIntegrity {
  size: number
  md5: string
  sha1: string
  sha256: string
  sha512: string
}

interface FontSource {
  name: string
  url: string
}

interface PreparedFont {
  buffer: Buffer
  downloaded: boolean
}

export interface LoadedFont {
  fontBase64: string
  fontPath: string
  managed: boolean
  downloaded: boolean
}

export type FontErrorCode =
  | 'download-failed'
  | 'integrity-failed'
  | 'invalid-font'
  | 'read-failed'
  | 'write-failed'

export class FontError extends Error {
  readonly name = 'FontError'

  constructor(
    readonly code: FontErrorCode,
    readonly fontPath: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export const LXGW_WENKAI_INTEGRITY: Readonly<FontIntegrity> = {
  size: 24755236,
  md5: '90e75a25cca0e8868977b880352c6a53',
  sha1: '7f018ad4a181e4d2df4f972f357e612885d6c24a',
  sha256: 'ee9faa6479c5b2434f9bceca8e2e7b643f699f4f3d067aac9609261e07c6be61',
  sha512: '793dc4357d311dba539c50b0ae38ff247af066f141ffea54ff0cc51e274453671e736989cee4998fd89211035ecfe52ad38aa828ba7f1739bcf107b94a023be5',
}

const FONT_SOURCES: FontSource[] = [
  { name: 'Gitee', url: LXGW_WENKAI_URL },
  { name: 'GitHub', url: LXGW_WENKAI_GITHUB_URL },
]

const managedLoads = new Map<string, Promise<PreparedFont>>()

export function getFontDirByBaseDir(baseDir: string): string {
  return path.join(baseDir, 'data', 'fonts')
}

export function getLxgwWenKaiPathByBaseDir(baseDir: string): string {
  return path.join(getFontDirByBaseDir(baseDir), LXGW_WENKAI_FILE_NAME)
}

// Schema 无法访问 ctx.baseDir，因此配置页使用 cwd 展示默认路径。
export const DEFAULT_LXGW_WENKAI_PATH = getLxgwWenKaiPathByBaseDir(process.cwd())

export function resolveRuntimeFontPath(ctx: Context, configuredPath?: string): string {
  const runtimeDefault = getLxgwWenKaiPathByBaseDir(ctx.baseDir)
  const configured = configuredPath?.trim()

  if (!configured || pathsEqual(configured, DEFAULT_LXGW_WENKAI_PATH) || pathsEqual(configured, runtimeDefault)) {
    return runtimeDefault
  }

  return configured
}

export class FontManager {
  readonly configuredPath: string
  readonly fontPath: string
  readonly managed: boolean

  private readonly logger: ReturnType<Context['logger']>
  private cached: LoadedFont | null = null
  private pending: Promise<LoadedFont> | null = null
  private failure: unknown

  constructor(private readonly ctx: Context, configuredPath = DEFAULT_LXGW_WENKAI_PATH) {
    this.configuredPath = configuredPath.trim()
    this.fontPath = resolveRuntimeFontPath(ctx, this.configuredPath)
    this.managed = isManagedPath(ctx, this.configuredPath)
    this.logger = ctx.logger('cs2-update-log')
  }

  async load(): Promise<LoadedFont> {
    if (this.cached) return this.cached
    if (this.failure) throw this.failure
    if (this.pending) return this.pending

    const pending = this.loadUncached()
    this.pending = pending

    try {
      const loaded = await pending
      this.cached = loaded
      return loaded
    } catch (error) {
      this.failure = error
      const message = '字体加载失败，图片渲染应回退到系统字体：path=%s error=%s'
      if (this.managed) this.logger.warn(message, this.fontPath, formatError(error))
      else this.logger.error(message, this.fontPath, formatError(error))
      throw error
    } finally {
      if (this.pending === pending) this.pending = null
    }
  }

  async getBase64(): Promise<string> {
    return (await this.load()).fontBase64
  }

  async getBase64OrEmpty(): Promise<string> {
    try {
      return await this.getBase64()
    } catch {
      return ''
    }
  }

  clearCache(): void {
    this.cached = null
    this.failure = undefined
  }

  private async loadUncached(): Promise<LoadedFont> {
    const prepared = this.managed
      ? await prepareManagedFont(this.ctx, this.logger, this.fontPath)
      : await readCustomFont(this.fontPath)

    return {
      fontBase64: prepared.buffer.toString('base64'),
      fontPath: this.fontPath,
      managed: this.managed,
      downloaded: prepared.downloaded,
    }
  }
}

function isManagedPath(ctx: Context, configuredPath: string): boolean {
  if (!configuredPath) return true
  return pathsEqual(configuredPath, DEFAULT_LXGW_WENKAI_PATH)
    || pathsEqual(configuredPath, getLxgwWenKaiPathByBaseDir(ctx.baseDir))
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  if (process.platform === 'win32') return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
  return normalizedLeft === normalizedRight
}

async function prepareManagedFont(
  ctx: Context,
  logger: ReturnType<Context['logger']>,
  fontPath: string,
): Promise<PreparedFont> {
  const key = process.platform === 'win32' ? path.resolve(fontPath).toLowerCase() : path.resolve(fontPath)
  const active = managedLoads.get(key)
  if (active) return active

  const pending = prepareManagedFontUncached(ctx, logger, fontPath)
  managedLoads.set(key, pending)

  try {
    return await pending
  } finally {
    if (managedLoads.get(key) === pending) managedLoads.delete(key)
  }
}

async function prepareManagedFontUncached(
  ctx: Context,
  logger: ReturnType<Context['logger']>,
  fontPath: string,
): Promise<PreparedFont> {
  const existing = await readOptionalFile(fontPath)
  if (existing && verifyLxgwBuffer(existing)) {
    logger.debug('LXGW 字体已存在且完整性校验通过：%s', fontPath)
    return { buffer: existing, downloaded: false }
  }

  if (existing) logger.warn('LXGW 字体完整性校验失败，将重新下载：%s', fontPath)
  try {
    await mkdir(path.dirname(fontPath), { recursive: true })
  } catch (error) {
    throw new FontError('write-failed', fontPath, `无法创建 LXGW 字体目录：${formatError(error)}`, error)
  }

  let lastError: unknown
  for (const source of FONT_SOURCES) {
    try {
      logger.info('开始从 %s 下载 LXGW 字体：%s', source.name, source.url)
      const data = await ctx.http.get<ArrayBuffer>(source.url, {
        responseType: 'arraybuffer',
        timeout: 120000,
      })
      const buffer = Buffer.from(data)
      if (!verifyLxgwBuffer(buffer)) {
        throw new FontError('integrity-failed', fontPath, `${source.name} 返回的 LXGW 字体完整性校验失败`)
      }

      await replaceFontAtomically(fontPath, buffer)
      logger.info('LXGW 字体下载完成且完整性校验通过：source=%s path=%s', source.name, fontPath)
      return { buffer, downloaded: true }
    } catch (error) {
      lastError = error
      logger.warn('%s LXGW 字体下载失败，将尝试下一个源：%s', source.name, formatError(error))
    }
  }

  throw new FontError(
    'download-failed',
    fontPath,
    `LXGW 字体下载失败，Gitee 与 GitHub 均不可用或校验失败：${formatError(lastError)}`,
    lastError,
  )
}

async function readCustomFont(fontPath: string): Promise<PreparedFont> {
  let buffer: Buffer
  try {
    buffer = await readFile(fontPath)
  } catch (error) {
    throw new FontError('read-failed', fontPath, `无法读取自定义字体：${fontPath}，${formatError(error)}`, error)
  }

  if (!hasFontSignature(buffer)) {
    throw new FontError('invalid-font', fontPath, `自定义字体文件格式无效：${fontPath}`)
  }

  return { buffer, downloaded: false }
}

async function readOptionalFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw new FontError('read-failed', filePath, `无法读取托管字体：${filePath}，${formatError(error)}`, error)
  }
}

async function replaceFontAtomically(fontPath: string, buffer: Buffer): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(fontPath),
    `.${path.basename(fontPath)}.${process.pid}.${randomUUID()}.tmp`,
  )

  try {
    await writeFile(temporaryPath, buffer, { flag: 'wx' })
    const temporaryBuffer = await readFile(temporaryPath)
    if (!verifyLxgwBuffer(temporaryBuffer)) {
      throw new FontError('integrity-failed', fontPath, 'LXGW 字体临时文件完整性校验失败')
    }

    await rename(temporaryPath, fontPath)
    const installed = await readFile(fontPath)
    if (!verifyLxgwBuffer(installed)) {
      throw new FontError('integrity-failed', fontPath, 'LXGW 字体原子替换后完整性校验失败')
    }
  } catch (error) {
    if (error instanceof FontError) throw error
    throw new FontError('write-failed', fontPath, `无法原子写入 LXGW 字体：${formatError(error)}`, error)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

function verifyLxgwBuffer(buffer: Buffer): boolean {
  if (buffer.length !== LXGW_WENKAI_INTEGRITY.size) return false
  const hashes = calculateHashes(buffer)
  return hashes.md5 === LXGW_WENKAI_INTEGRITY.md5
    && hashes.sha1 === LXGW_WENKAI_INTEGRITY.sha1
    && hashes.sha256 === LXGW_WENKAI_INTEGRITY.sha256
    && hashes.sha512 === LXGW_WENKAI_INTEGRITY.sha512
}

function calculateHashes(buffer: Buffer) {
  return {
    md5: createHash('md5').update(buffer).digest('hex'),
    sha1: createHash('sha1').update(buffer).digest('hex'),
    sha256: createHash('sha256').update(buffer).digest('hex'),
    sha512: createHash('sha512').update(buffer).digest('hex'),
  }
}

function hasFontSignature(buffer: Buffer): boolean {
  if (buffer.length < 12) return false
  const tag = buffer.subarray(0, 4).toString('latin1')
  return buffer.readUInt32BE(0) === 0x00010000
    || ['OTTO', 'ttcf', 'true', 'typ1', 'wOFF', 'wOF2'].includes(tag)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
