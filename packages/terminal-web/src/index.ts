import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/terminal'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'terminal-web'
export const inject = ['web', 'terminal']

/**
 * List, create, type into and close the user's terminals.
 *
 * Input is a POST body rather than a dedicated WebSocket: output rides the
 * existing `ui` broadcast (SSE + WebSocket relay), and keystrokes batch on the
 * client side. Nothing here is exposed as an agent tool.
 */
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.web.register({
        prefix: '/api/terminal',
        handler: (req, res, url) => handle(ctx, req, res, url),
      }),
    'terminal-web.api',
  )

  const push = (payload: unknown) => {
    const ui = ctx.get('ui', false) as { broadcast?(channel: string, data: unknown): void } | undefined
    ui?.broadcast?.('terminal', payload)
  }

  ctx.effect(() => {
    const offOutput = ctx.on('terminal/output', (id, data) => push({ kind: 'output', id, data }))
    const offExit = ctx.on('terminal/exit', (id, code) => push({ kind: 'exit', id, code }))
    const offChanged = ctx.on('terminal/changed', terminals => push({ kind: 'changed', terminals }))
    return () => {
      offOutput()
      offExit()
      offChanged()
    }
  }, 'terminal-web.push')
}

export default { name, inject, apply }

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean) // api, terminal, id?, action?
  const method = req.method ?? 'GET'

  if (parts.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, { terminals: ctx.terminal.list() })
      return true
    }
    if (method === 'POST') {
      const body = await readJson(req) as { cwd?: string; cols?: number; rows?: number }
      const terminal = ctx.terminal.create(body)
      sendJson(res, 201, { terminal })
      return true
    }
    throw new HttpError(405, 'method not allowed')
  }

  const id = decodeURIComponent(parts[2] ?? '')
  if (!id) throw new HttpError(404, 'not found')

  if (parts.length === 3) {
    if (method === 'DELETE') {
      ctx.terminal.kill(id)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (method === 'GET') {
      sendJson(res, 200, { terminal: ctx.terminal.list().find(item => item.id === id) ?? null })
      return true
    }
    throw new HttpError(405, 'method not allowed')
  }

  if (parts.length === 4 && parts[3] === 'input') {
    if (method !== 'POST') throw new HttpError(405, 'method not allowed')
    const body = await readJson(req) as { data?: string }
    ctx.terminal.write(id, body?.data)
    sendJson(res, 200, { ok: true })
    return true
  }

  if (parts.length === 4 && parts[3] === 'resize') {
    if (method !== 'POST') throw new HttpError(405, 'method not allowed')
    const body = await readJson(req) as { cols?: number; rows?: number }
    sendJson(res, 200, ctx.terminal.resize(id, body?.cols, body?.rows))
    return true
  }

  if (parts.length === 4 && parts[3] === 'buffer') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed')
    sendJson(res, 200, { buffer: ctx.terminal.buffer(id) })
    return true
  }

  throw new HttpError(404, 'not found')
}

export const meta = {
  title: '终端接口',
  description: '终端列表、输入、缓冲区与关闭。',
}
