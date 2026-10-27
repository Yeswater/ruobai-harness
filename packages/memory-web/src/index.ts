import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type { MemoryItem } from '@ruobai/memory'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'memory-web'
export const inject = ['web', 'memory', 'sessions']

/** Long-term memory CRUD for the settings panel. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/memory',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'memory-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')
    const path = url.pathname

    if (path === '/api/memory' && req.method === 'GET') {
      const items = [...(await ctx.memory.items(sessionId)).values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
      sendJson(res, 200, {
        items: items.map(publicItem),
        stats: await ctx.memory.stats(sessionId),
      })
      return true
    }

    if (path === '/api/memory' && req.method === 'POST') {
      const body = await readJson(req)
      const saved = await ctx.memory.save({
        text: String(body?.text ?? ''),
        ...(body?.kind ? { kind: body.kind } : {}),
        ...(Array.isArray(body?.tags) ? { tags: body.tags } : {}),
        ...(body?.scope === 'global' || body?.scope === 'project' ? { scope: body.scope } : {}),
        ...(body?.pinned === true ? { pinned: true } : {}),
      }, sessionId)
      sendJson(res, 201, { id: saved.id, created: saved.created, item: publicItem(saved.item) })
      return true
    }

    if (path === '/api/memory/search' && req.method === 'GET') {
      const result = await ctx.memory.search(url.searchParams.get('q') ?? '', {
        limit: Number(url.searchParams.get('limit')) || undefined,
        ...(url.searchParams.get('scope') === 'global' || url.searchParams.get('scope') === 'project'
          ? { scope: url.searchParams.get('scope') as 'global' | 'project' }
          : {}),
      }, sessionId)
      sendJson(res, 200, { items: result.items.map(publicItem), truncated: result.truncated })
      return true
    }

    const pin = /^\/api\/memory\/([^/]+)\/pin$/.exec(path)
    if (pin && req.method === 'POST') {
      const body = await readJson(req)
      const item = await ctx.memory.pin(decodeURIComponent(pin[1]!), body?.pinned !== false, sessionId)
      sendJson(res, 200, { item: publicItem(item) })
      return true
    }

    const one = /^\/api\/memory\/([^/]+)$/.exec(path)
    if (one && req.method === 'DELETE') {
      const forgotten = await ctx.memory.forget({ id: decodeURIComponent(one[1]!) }, sessionId)
      sendJson(res, 200, { forgotten })
      return true
    }

    throw new HttpError(404, 'not found')
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400
    if (status === 400) ctx.logger('memory-web').warn(error)
    if (!res.headersSent) {
      sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }
  return true
}

function publicItem(item: MemoryItem) {
  return {
    id: item.id,
    scope: item.scope,
    kind: item.kind,
    text: item.text,
    tags: item.tags,
    pinned: Boolean(item.pinned),
    confidence: item.confidence,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    validFrom: item.validFrom,
    ...(item.validTo ? { validTo: item.validTo } : {}),
    hits: item.hits,
    ...(item.lastUsedAt ? { lastUsedAt: item.lastUsedAt } : {}),
    ...(item.supersedes ? { supersedes: item.supersedes } : {}),
    source: item.source,
  }
}

export default { name, inject, apply }

export const meta = {
  title: '记忆接口',
  description: '长期记忆的列表、检索、固定与遗忘接口。',
}
