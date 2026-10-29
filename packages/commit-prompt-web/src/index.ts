import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/commit-prompt'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'commit-prompt-web'
export const inject = ['web', 'commitPrompt', 'sessions']

/**
 * Card surface: the pending proposal for reconnect, the accept/dismiss
 * endpoint, and the live push the card listens to.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/commits',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'commit-prompt-web.routes')

  ctx.effect(() => {
    const broadcast = (data: unknown) => {
      const ui = ctx.get('ui', false) as { broadcast?(channel: string, data: unknown): void } | undefined
      ui?.broadcast?.('commit', data)
    }
    const offRequested = ctx.on('commit/requested', proposal => broadcast({ kind: 'requested', proposal }))
    const offResolved = ctx.on('commit/resolved', resolution => broadcast({ kind: 'resolved', resolution }))
    return () => {
      offRequested()
      offResolved()
    }
  }, 'commit-prompt-web.push')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method ?? 'GET'

  if (url.pathname.replace(/\/$/, '') === '/api/commits') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed')
    const sessionId = url.searchParams.get('sessionId')?.trim() || undefined
    if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, `unknown session: ${sessionId}`)
    sendJson(res, 200, { proposals: ctx.commitPrompt.list(sessionId) })
    return true
  }

  const match = /^\/api\/commits\/([^/]+)$/.exec(url.pathname)
  if (match) {
    if (method !== 'POST') throw new HttpError(405, 'method not allowed')
    const body = await readJson(req)
    const action = body?.action
    if (action !== 'commit' && action !== 'dismiss') throw new HttpError(400, 'action must be commit or dismiss')
    const resolution = await ctx.commitPrompt.resolve(decodeURIComponent(match[1]!), {
      action,
      ...(typeof body?.message === 'string' ? { message: body.message } : {}),
    })
    if (!resolution) throw new HttpError(404, 'commit proposal is no longer waiting')
    sendJson(res, 200, { resolution })
    return true
  }

  throw new HttpError(404, 'not found')
}

export default { name, inject, apply }

export const meta = {
  title: '提交卡片通道',
  description: '把待确认的提交推给界面，并接收用户的提交或放弃。',
}
