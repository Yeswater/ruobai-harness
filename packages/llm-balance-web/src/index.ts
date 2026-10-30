import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { HttpError, sendJson } from '@ruobai/web-server'

export const name = 'llm-balance-web'
export const inject = ['web', 'llmBalance']

/** Provider balances and today's token totals for the sidebar card. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/llm/overview',
    handler: (req, res, url) => handleOverview(ctx, req, res, url),
  }), 'llm-balance-web.overview')
}

export default { name, inject, apply }

async function handleOverview(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname !== '/api/llm/overview') throw new HttpError(404, 'not found')
  if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
  const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true'
  sendJson(res, 200, await ctx.llmBalance.overview(refresh))
  return true
}

export const meta = {
  title: '模型余额接口',
  description: '提供供应商余额与今日用量快照。',
}
