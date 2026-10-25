import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { HttpError, sendJson } from '@ruobai/web-server'
import type {} from '@ruobai/a2a'

export const name = 'a2a-web'
export const inject = ['web', 'a2a']

/** Read-only A2A status for the protocols page. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'a2a-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname !== '/api/a2a') return false
  try {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    sendJson(res, 200, ctx.a2a.info())
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) ctx.logger('a2a-web').error(error)
    if (!res.headersSent) {
      sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }
  return true
}

export default { name, inject, apply }

export const meta = {
  title: 'A2A 接口',
  description: '提供远端 A2A agent 的状态与技能信息。',
}
