import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { HttpError, sendJson } from '@ruobai/web-server'
import { WorkspaceError } from '@ruobai/workspace'

export const name = 'workspace-web'
export const inject = ['web', 'workspace', 'sessions']

/** Exposes the read-only workspace service to the browser. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/workspace',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'workspace-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  try {
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')

    if (url.pathname === '/api/workspace/tree') {
      const depthValue = Number(url.searchParams.get('depth'))
      const depth = Number.isFinite(depthValue) && depthValue > 0 ? Math.floor(depthValue) : undefined
      const tree = await ctx.workspace.tree(url.searchParams.get('path') ?? '.', depth, sessionId)
      sendJson(res, 200, { tree })
      return true
    }
    if (url.pathname === '/api/workspace/file') {
      const path = url.searchParams.get('path')
      if (!path) throw new HttpError(400, 'path is required')
      sendJson(res, 200, await ctx.workspace.read(path, sessionId))
      return true
    }
    if (url.pathname === '/api/workspace/browse') {
      sendJson(res, 200, await ctx.workspace.browse(url.searchParams.get('path') ?? undefined))
      return true
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    const status = error instanceof WorkspaceError ? error.status : error instanceof HttpError ? error.status : 500
    if (status === 500) ctx.logger('workspace-web').error(error)
    sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
  }
  return true
}

export default { name, inject, apply }
