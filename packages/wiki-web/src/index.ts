import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { parsePage } from '@ruobai/wiki'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'wiki-web'
export const inject = ['web', 'wiki', 'sessions']

/** Wiki browse / search / edit / proposals / history API. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/wiki',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'wiki-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')
    const path = url.pathname

    if (path === '/api/wiki' && req.method === 'GET') {
      sendJson(res, 200, {
        pages: await ctx.wiki.pages(sessionId),
        proposals: await ctx.wiki.proposals(sessionId),
        stats: await ctx.wiki.stats(sessionId),
      })
      return true
    }

    if (path === '/api/wiki/search' && req.method === 'GET') {
      const result = await ctx.wiki.search(url.searchParams.get('q') ?? '', {
        limit: Number(url.searchParams.get('limit')) || undefined,
      }, sessionId)
      sendJson(res, 200, result)
      return true
    }

    if (path === '/api/wiki/lint' && req.method === 'GET') {
      sendJson(res, 200, { findings: await ctx.wiki.lint(sessionId) })
      return true
    }

    if (path === '/api/wiki/proposals' && req.method === 'GET') {
      sendJson(res, 200, { proposals: await ctx.wiki.proposals(sessionId) })
      return true
    }
    if (path === '/api/wiki/proposals' && req.method === 'POST') {
      if (!sessionId) throw new HttpError(400, 'sessionId is required')
      const body = await readJson(req)
      const proposal = await ctx.wiki.propose({
        sessionId,
        ...(typeof body?.title === 'string' && body.title.trim() ? { title: body.title } : {}),
        ...(typeof body?.body === 'string' && body.body.trim() ? { body: body.body } : {}),
      })
      sendJson(res, 201, proposal)
      return true
    }

    const accept = /^\/api\/wiki\/proposals\/([^/]+)\/accept$/.exec(path)
    if (accept && req.method === 'POST') {
      const result = await ctx.wiki.acceptProposal(decodeURIComponent(accept[1]!), sessionId)
      sendJson(res, 200, result)
      return true
    }
    const proposal = /^\/api\/wiki\/proposals\/([^/]+)$/.exec(path)
    if (proposal && req.method === 'DELETE') {
      await ctx.wiki.rejectProposal(decodeURIComponent(proposal[1]!), sessionId)
      sendJson(res, 200, { ok: true })
      return true
    }

    const backlinks = /^\/api\/wiki\/page\/([^/]+)\/backlinks$/.exec(path)
    if (backlinks && req.method === 'GET') {
      sendJson(res, 200, { backlinks: await ctx.wiki.backlinks(decodeURIComponent(backlinks[1]!), sessionId) })
      return true
    }
    const versions = /^\/api\/wiki\/page\/([^/]+)\/versions$/.exec(path)
    if (versions && req.method === 'GET') {
      sendJson(res, 200, { versions: await ctx.wiki.versions(decodeURIComponent(versions[1]!), sessionId) })
      return true
    }
    const version = /^\/api\/wiki\/page\/([^/]+)\/versions\/(\d+)$/.exec(path)
    if (version && req.method === 'GET') {
      const text = await ctx.wiki.version(
        decodeURIComponent(version[1]!),
        Number(version[2]),
        sessionId,
      )
      if (text === undefined) throw new HttpError(404, 'no such version')
      sendJson(res, 200, { text })
      return true
    }
    const diff = /^\/api\/wiki\/page\/([^/]+)\/diff$/.exec(path)
    if (diff && req.method === 'GET') {
      const from = Number(url.searchParams.get('from'))
      const to = Number(url.searchParams.get('to'))
      const text = await ctx.wiki.diffVersions(decodeURIComponent(diff[1]!), from, to, sessionId)
      if (text === undefined) throw new HttpError(404, 'no such version')
      sendJson(res, 200, { diff: text })
      return true
    }

    if (path === '/api/wiki/page' && req.method === 'POST') {
      const body = await readJson(req)
      const result = await ctx.wiki.write({
        title: String(body?.title ?? ''),
        body: String(body?.body ?? ''),
        ...(Array.isArray(body?.tags) ? { tags: body.tags } : {}),
        ...(typeof body?.id === 'string' && body.id.trim() ? { id: body.id } : {}),
      }, sessionId)
      sendJson(res, 201, { id: result.id, revision: result.revision })
      return true
    }

    const page = /^\/api\/wiki\/page\/([^/]+)$/.exec(path)
    if (page) {
      const id = decodeURIComponent(page[1]!)
      if (req.method === 'GET') {
        const raw = await ctx.wiki.raw(id, sessionId)
        if (raw === undefined) throw new HttpError(404, 'no such page')
        const doc = parsePage(raw)
        if (!doc) throw new HttpError(422, 'invalid page')
        sendJson(res, 200, {
          meta: doc.meta,
          body: doc.body,
          stale: await ctx.wiki.staleSources(id, sessionId),
        })
        return true
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        const result = await ctx.wiki.write({
          id,
          title: typeof body?.title === 'string' ? body.title : id,
          body: String(body?.body ?? ''),
          ...(Array.isArray(body?.tags) ? { tags: body.tags } : {}),
        }, sessionId)
        sendJson(res, 200, { id: result.id, revision: result.revision })
        return true
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, await ctx.wiki.archive(id, sessionId))
        return true
      }
    }

    throw new HttpError(404, 'not found')
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400
    if (status === 400) ctx.logger('wiki-web').warn(error)
    if (!res.headersSent) {
      sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }
  return true
}

export default { name, inject, apply }

export const meta = {
  title: '知识库接口',
  description: '页面浏览、检索、编辑、提案审核与历史对比接口。',
}
