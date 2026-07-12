import { createHash } from 'node:crypto'

export function hashCacheKey(...parts: string[]) {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part)
    hash.update('\0')
  }
  return hash.digest('hex')
}
