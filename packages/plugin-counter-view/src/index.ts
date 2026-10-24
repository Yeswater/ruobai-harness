import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/cordis-plugin-timer'
import type {} from '@ruobai/plugin-counter'

/** Function plugin with two injected services: it stays PENDING until both exist. */
export const name = 'counter-view'
export const inject = ['counter', 'timer']

export function apply(ctx: Context) {
  const logger = ctx.logger('counter-view')

  const render = (value: number) => logger.info('counter is now %d', value)
  render(ctx.counter.current)
  ctx.on('counter/changed', render)

  // `ctx.interval` is already an effect: unloading this plugin clears it.
  ctx.interval(() => ctx.counter.increment(), 2_000)
}

export const meta = {
  title: '计数器视图',
  description: '演示客户端视图插件。',
}
