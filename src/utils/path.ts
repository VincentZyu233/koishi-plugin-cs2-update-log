import type { Context } from 'koishi'
import path from 'node:path'

export function resolveStatePath(ctx: Context, stateFile: string) {
  if (path.isAbsolute(stateFile)) return stateFile
  const baseDir = typeof ctx.baseDir === 'string' ? ctx.baseDir : process.cwd()
  return path.resolve(baseDir, stateFile)
}
