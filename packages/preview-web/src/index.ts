import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/preview'
import { HttpError, sendJson } from '@ruobai/web-server'

export const name = 'preview-web'
export const inject = ['web', 'preview']

/** Snapshot, start/stop/restart and logs for `launch.json` entries. */
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.web.register({
        prefix: '/api/preview',
        handler: (req, res, url) => handle(ctx, req, res, url),
      }),
    'preview-web.api',
  )

  const push = (payload: unknown) => {
    const ui = ctx.get('ui', false) as { broadcast?(channel: string, data: unknown): void } | undefined
    ui?.broadcast?.('preview', payload)
  }

  ctx.effect(() => {
    const offState = ctx.on('preview/state', state => push({ kind: 'state', state }))
    const offLog = ctx.on('preview/log', (name, line) => push({ kind: 'log', name, line }))
    return () => {
      offState()
      offLog()
    }
  }, 'preview-web.push')
}

export default { name, inject, apply }

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean) // api, preview, name?, action?
  const method = req.method ?? 'GET'
  // Configurations belong to the session's workspace, not the harness cwd: a
  // session in another folder must not list or start this one's servers.
  const root = workspaceOf(ctx, url)

  if (parts.length === 2) {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed')
    sendJson(res, 200, await ctx.preview.snapshot(root))
    return true
  }

  const name = decodeURIComponent(parts[2] ?? '')
  if (!name) throw new HttpError(404, 'not found')

  if (parts.length === 3) {
    if (method === 'GET') {
      sendJson(res, 200, await ctx.preview.logs(name, root))
      return true
    }
    throw new HttpError(405, 'method not allowed')
  }

  if (parts.length !== 4) throw new HttpError(404, 'not found')
  const action = parts[3]
  if (method !== 'POST') throw new HttpError(405, 'method not allowed')

  if (action === 'start') {
    sendJson(res, 200, { state: await ctx.preview.start(name, root) })
    return true
  }
  if (action === 'stop') {
    sendJson(res, 200, { state: await ctx.preview.stop(name, root) })
    return true
  }
  if (action === 'restart') {
    sendJson(res, 200, { state: await ctx.preview.restart(name, root) })
    return true
  }

  throw new HttpError(404, 'not found')
}

function workspaceOf(ctx: Context, url: URL): string | undefined {
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) return undefined
  const sessions = ctx.get('sessions', false) as
    | { get?(id: string): { meta?: { workspace?: string } } | undefined }
    | undefined
  return sessions?.get?.(sessionId)?.meta?.workspace
}

export const meta = {
  title: '预览接口',
  description: 'launch.json 配置、启停与日志。',
}
