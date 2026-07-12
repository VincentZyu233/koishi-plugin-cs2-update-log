import { Context } from 'koishi'

import { Config } from './config'
import { registerCommands } from './commands'
import { Cs2UpdateLogRuntime } from './runtime'

export const name = 'cs2-update-log'

export const inject = {
  required: ['http'],
  optional: ['puppeteer'],
}

export { Config }
export { usage } from './usage'

export function apply(ctx: Context, config: Config) {
  const runtime = new Cs2UpdateLogRuntime(ctx, config)
  registerCommands(ctx, config, runtime)
  runtime.start()
}
