import type { Context } from '@ruobai/cordis'

export const name = 'welcome'

/** Server half: the row exists in cordis.yml; the UI half is loaded by client-modules. */
export function apply(ctx: Context) {
  ctx.logger('welcome').info('welcome plugin loaded')
}

export default { name, apply }

export const meta = {
  title: '欢迎示例',
  description: '演示客户端插件与侧边卡片。',
}
