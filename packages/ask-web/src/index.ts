import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/ask'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'ask-web'
export const inject = ['web', 'ask', 'sessions']

/**
 * Question surface: the pending list for reconnect, the answer endpoint, and
 * the live push the card listens to.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/asks',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'ask-web.routes')

  ctx.effect(() => {
    const broadcast = (data: unknown) => {
      const ui = ctx.get('ui', false) as { broadcast?(channel: string, data: unknown): void } | undefined
      ui?.broadcast?.('ask', data)
    }
    const offRequested = ctx.on('ask/requested', request => broadcast({ kind: 'requested', request }))
    const offResolved = ctx.on('ask/resolved', (resolution) => {
      broadcast({
        kind: 'resolved',
        resolution: { id: resolution.id, via: resolution.via, answer: resolution.answer },
      })
    })
    return () => {
      offRequested()
      offResolved()
    }
  }, 'ask-web.push')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method ?? 'GET'

  if (url.pathname.replace(/\/$/, '') === '/api/asks') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed')
    const sessionId = url.searchParams.get('sessionId')?.trim() || undefined
    if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, `unknown session: ${sessionId}`)
    sendJson(res, 200, { asks: ctx.ask.list(sessionId) })
    return true
  }

  const answer = /^\/api\/asks\/([^/]+)\/answer$/.exec(url.pathname)
  if (answer) {
    if (method !== 'POST') throw new HttpError(405, 'method not allowed')
    const body = await readJson(req)
    const resolution = ctx.ask.answer(decodeURIComponent(answer[1]!), body?.answer)
    if (!resolution) throw new HttpError(404, 'question is no longer waiting for an answer')
    sendJson(res, 200, { ok: true, via: resolution.via })
    return true
  }

  throw new HttpError(404, 'not found')
}

export default { name, inject, apply }

export const meta = {
  title: '提问通道',
  description: '把待回答的问题推给界面，并接收用户的回答。',
}
