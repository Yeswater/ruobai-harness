import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'checkpoints-web'
export const inject = ['web', 'checkpoints', 'sessions']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/checkpoints',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'checkpoints-web.routes')
}

export default { name, inject, apply }

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const parts = url.pathname.split('/').filter(Boolean) // ['api','checkpoints',id,'revert'?]
    if (parts.length < 3 || parts.length > 4) throw new HttpError(404, 'not found')

    const sessionId = decodeURIComponent(parts[2]!)
    if (!ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')

    if (parts.length === 3) {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
      sendJson(res, 200, { changes: ctx.checkpoints.changes(sessionId) })
      return true
    }

    if (parts[3] !== 'revert' || req.method !== 'POST') throw new HttpError(404, 'not found')
    const body = await readJson(req)
    const upToSeq = typeof body?.upToSeq === 'number' && Number.isFinite(body.upToSeq)
      ? Math.floor(body.upToSeq)
      : -1
    sendJson(res, 200, await ctx.checkpoints.revert(sessionId, upToSeq))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : 500
    if (status >= 500) ctx.logger('checkpoints-web').error(error)
    if (!res.headersSent) sendJson(res, status, { error: message })
  }
  return true
}
