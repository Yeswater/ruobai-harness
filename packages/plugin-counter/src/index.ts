import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

export interface Config {
  /** Starting value. */
  initial?: number
}

declare module '@ruobai/cordis' {
  interface Context {
    counter: CounterService
  }

  interface Events {
    'counter/changed'(value: number): void
  }
}

/** Class plugin: `super(ctx, 'counter')` publishes `ctx.counter` as an effect. */
export class CounterService extends Service {
  static Config: z<Config> = z.object({
    initial: z.number().min(0).default(0),
  })

  private value: number

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'counter')
    this.value = config.initial ?? 0
    ctx.logger('counter').info('counter starts at %d', this.value)
  }

  get current() {
    return this.value
  }

  increment(by = 1) {
    this.value += by
    this.ctx.emit('counter/changed', this.value)
    return this.value
  }

  reset() {
    this.value = 0
    this.ctx.emit('counter/changed', this.value)
  }
}

export default CounterService

export const meta = {
  title: '计数器示例',
  description: '演示客户端插件状态同步。',
}
