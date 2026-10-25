import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { HttpError, sendJson } from '@ruobai/web-server'

export const name = 'skills-web'
export const inject = ['web', 'skills', 'sessions']

/** Read-only skill catalog for the composer menu and the protocols page. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'skills-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname !== '/api/skills') return false
  try {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')
    sendJson(res, 200, {
      skills: await ctx.skills.list(sessionId),
      roots: ctx.skills.roots(sessionId),
    })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) ctx.logger('skills-web').error(error)
    if (!res.headersSent) {
      sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }
  return true
}

export default { name, inject, apply }

export const meta = {
  title: '技能接口',
  description: '提供只读的技能目录与扫描根信息。',
}
