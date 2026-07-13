import type { LlmApiFormat } from './config'
import { formatError } from './utils/error'

export type LlmErrorKind = 'timeout' | 'truncated' | 'invalid-response' | 'request-error'

export interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | OpenAiTextBlock[]
    }
  }>
}

interface OpenAiTextBlock {
  type?: string
  text?: string
}

export interface AnthropicResponse {
  stop_reason?: string | null
  content?: Array<{
    type?: string
    text?: string
  }>
}

export class LlmProtocolError extends Error {
  constructor(
    readonly kind: Exclude<LlmErrorKind, 'timeout' | 'request-error'>,
    message: string,
  ) {
    super(message)
    this.name = 'LlmProtocolError'
  }
}

export function appendEndpoint(baseUrl: string, endpoint: string): string {
  const base = String(baseUrl || '').trim()
  if (!base) return ''

  try {
    const url = new URL(base)
    const pathname = url.pathname.replace(/\/+$/, '')
    if (isCompleteEndpoint(pathname, endpoint)) return base.replace(/\/+$/, '')

    const suffix = pathname.endsWith('/v1') && endpoint.startsWith('/v1/')
      ? endpoint.slice(3)
      : endpoint
    url.pathname = `${pathname}${suffix}`
    return url.toString()
  } catch {
    const normalized = base.replace(/\/+$/, '')
    if (isCompleteEndpoint(normalized, endpoint)) return normalized
    if (normalized.endsWith('/v1') && endpoint.startsWith('/v1/')) {
      return normalized + endpoint.slice(3)
    }
    return normalized + endpoint
  }
}

export function resolveLlmEndpoint(baseUrl: string, format: LlmApiFormat) {
  const endpoint = format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'
  return appendEndpoint(baseUrl, endpoint)
}

function isCompleteEndpoint(pathname: string, endpoint: string) {
  if (pathname.endsWith(endpoint)) return true
  if (endpoint.endsWith('/chat/completions')) return pathname.endsWith('/chat/completions')
  if (endpoint.endsWith('/messages')) return pathname.endsWith('/messages')
  return false
}

export function unexpectedTextResponse(protocol: string, response: string) {
  const responseType = /^\s*</.test(response) ? 'HTML' : 'plain text'
  return new LlmProtocolError(
    'invalid-response',
    `${protocol} endpoint returned ${responseType} instead of JSON; check llmApiEndpoint and llmApiFormat`,
  )
}

export function truncatedResponse(protocol: string, maxTokens: number, detail?: string) {
  const suffix = detail ? ` (${detail})` : ''
  return new LlmProtocolError(
    'truncated',
    `${protocol} response was truncated at llmMaxTokens=${maxTokens}${suffix}`,
  )
}

export function invalidResponse(message: string) {
  return new LlmProtocolError('invalid-response', message)
}

export function readOpenAiContent(content: string | OpenAiTextBlock[] | undefined) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function readAnthropicContent(response: AnthropicResponse) {
  return (response.content || [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function stripMarkdownFence(input: string) {
  const trimmed = input.trim()
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return match ? match[1] : trimmed
}

export function parseJsonObject(input: string) {
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
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {}
    }
    throw invalidResponse('translation response is not valid JSON')
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function shouldRetryWithMaxCompletionTokens(error: unknown) {
  const rendered = formatError(error).toLowerCase()
  return rendered.includes('max_tokens') && [
    'unsupported',
    'not supported',
    'unknown parameter',
    'incompatible',
  ].some((keyword) => rendered.includes(keyword))
}

export function classifyLlmError(error: unknown): LlmErrorKind {
  if (error instanceof LlmProtocolError) return error.kind

  const rendered = formatError(error).toLowerCase()
  if ([
    'etimedout',
    'timeout',
    'timed out',
    'aborted due to timeout',
  ].some((keyword) => rendered.includes(keyword))) return 'timeout'

  if ([
    'response was truncated',
    'stop_reason=max_tokens',
    'finish_reason=length',
  ].some((keyword) => rendered.includes(keyword))) return 'truncated'

  if ([
    'empty openai-compatible response',
    'empty anthropic response',
    'translation response',
    'instead of json',
  ].some((keyword) => rendered.includes(keyword))) return 'invalid-response'

  return 'request-error'
}
