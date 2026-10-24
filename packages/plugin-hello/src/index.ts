import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

/** Function plugin: the module namespace itself is the plugin object. */
export const name = 'hello'

export interface Config {
  /** Name printed in the greeting. */
  target?: string
}

export const Config: z<Config> = z.object({
  target: z.string().default('world'),
})

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('hello')
  logger.info('hello, %s', config.target)
  ctx.effect(() => () => logger.info('goodbye, %s', config.target))
}

export const meta = {
  title: 'Hello 示例',
  description: '服务端插件示例。',
}
