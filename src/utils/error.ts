export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error
}

export function formatError(error: unknown) {
  const lines: string[] = []
  appendErrorDetails(lines, error)
  return lines.join('\n')
}

export function formatAggregateError(error: unknown) {
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
