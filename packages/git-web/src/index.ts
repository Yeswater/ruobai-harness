import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { ignoredPath, proposeMessage } from '@ruobai/commit-prompt'
import { GitError, type GitLogQuery } from '@ruobai/git'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'
import { WorkspaceError } from '@ruobai/workspace'

export const name = 'git-web'
export const inject = ['web', 'git', 'workspace', 'sessions']

/**
 * HTTP adapter for the Git service. Reads are scoped to a session workspace;
 * mutations require one so a stray request cannot touch the harness checkout.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/git',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'git-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const route = url.pathname.slice('/api/git'.length) || '/'
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')

    if (req.method === 'GET') {
      await read(ctx, res, url, route, sessionId)
      return true
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
    await mutate(ctx, req, res, route)
    return true
  } catch (error) {
    const status = error instanceof HttpError
      ? error.status
      : error instanceof GitError
        ? error.status
        : error instanceof WorkspaceError ? error.status : 500
    if (status >= 500) ctx.logger('git-web').error(error)
    sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
  }
  return true
}

async function read(
  ctx: Context,
  res: ServerResponse,
  url: URL,
  route: string,
  sessionId?: string,
) {
  const root = ctx.workspace.rootFor(sessionId)

  if (route === '/info') {
    sendJson(res, 200, await ctx.git.info(root))
    return
  }
  if (route === '/status') {
    sendJson(res, 200, await ctx.git.status(root))
    return
  }
  if (route === '/diff') {
    const path = requirePath(ctx, root, url.searchParams.get('path'))
    const scope = url.searchParams.get('scope') ?? 'working'
    const hash = url.searchParams.get('hash') ?? undefined
    if (scope === 'commit' && !hash) throw new HttpError(400, 'hash is required')
    sendJson(res, 200, await ctx.git.diff(root, {
      path,
      staged: scope === 'staged',
      hash: scope === 'commit' ? hash : undefined,
    }))
    return
  }
  if (route === '/log') {
    const path = url.searchParams.get('path')
    const query: GitLogQuery = {
      limit: numberParam(url, 'limit'),
      skip: numberParam(url, 'skip'),
      all: ['1', 'true', 'yes'].includes((url.searchParams.get('all') ?? '').toLowerCase()),
      ref: url.searchParams.get('ref') ?? undefined,
      query: url.searchParams.get('q') ?? undefined,
    }
    if (path) query.path = requirePath(ctx, root, path)
    sendJson(res, 200, await ctx.git.log(root, query))
    return
  }
  if (route === '/commit') {
    const hash = url.searchParams.get('hash')
    if (!hash) throw new HttpError(400, 'hash is required')
    sendJson(res, 200, await ctx.git.commitDetail(root, hash))
    return
  }
  if (route === '/branches') {
    sendJson(res, 200, { branches: await ctx.git.branches(root) })
    return
  }
  if (route === '/hosts') {
    sendJson(res, 200, { hosts: await ctx.git.hostInfo(root) })
    return
  }
  if (route === '/suggestion') {
    const status = await ctx.git.status(root)
    const title = sessionId ? ctx.sessions.get(sessionId)?.meta.title : undefined
    sendJson(res, 200, proposeMessage({ ...(title ? { title } : {}), changes: status.changes }))
    return
  }
  throw new HttpError(404, 'not found')
}

async function mutate(ctx: Context, req: IncomingMessage, res: ServerResponse, route: string) {
  const body = await readJson(req) as Record<string, unknown>
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!sessionId || !ctx.sessions.has(sessionId)) throw new HttpError(400, 'sessionId is required')
  const root = ctx.workspace.rootFor(sessionId)

  if (route === '/stage' || route === '/unstage' || route === '/discard') {
    const paths = pathsOf(ctx, root, body.paths)
    if (route === '/stage') await ctx.git.stage(root, paths)
    else if (route === '/unstage') await ctx.git.unstage(root, paths)
    else await ctx.git.discard(root, paths)
    sendJson(res, 200, { ok: true })
    return
  }
  if (route === '/commit') {
    const message = typeof body.message === 'string' ? body.message : ''
    if (!message.trim()) throw new HttpError(400, 'message is required')
    const requested = Array.isArray(body.paths) ? pathsOf(ctx, root, body.paths) : []
    // AGENTS §9: secrets, session logs and build output never ride along, even
    // when a client asks for them.
    const paths = requested.filter(path => !ignoredPath(path))
    if (requested.length && !paths.length) {
      throw new HttpError(400, '这些路径不会被提交（.env、.sessions、.ruobai、dist 等）')
    }
    sendJson(res, 200, await ctx.git.commit(root, {
      message,
      amend: body.amend === true,
      signoff: body.signoff === true,
      paths,
    }))
    return
  }
  if (route === '/pr') {
    const title = typeof body.title === 'string' ? body.title : ''
    const branch = typeof body.branch === 'string' ? body.branch : ''
    const base = typeof body.base === 'string' ? body.base : ''
    if (!title.trim() || !branch.trim() || !base.trim()) {
      throw new HttpError(400, 'title, branch and base are required')
    }
    const files = Array.isArray(body.files)
      ? body.files
          .filter((item): item is string => typeof item === 'string' && item.length > 0)
          .slice(0, 500)
          .map(path => ctx.workspace.resolvePath(path, root).path)
      : []
    sendJson(res, 200, await ctx.git.createPullRequest(root, {
      title,
      branch,
      base,
      files,
      ...(typeof body.body === 'string' && body.body.trim() ? { body: body.body } : {}),
    }))
    return
  }
  if (route === '/fetch') {
    sendJson(res, 200, await ctx.git.fetch(root))
    return
  }
  if (route === '/pull') {
    sendJson(res, 200, await ctx.git.pull(root))
    return
  }
  if (route === '/push') {
    const remote = typeof body.remote === 'string' && body.remote.trim() ? body.remote.trim() : undefined
    sendJson(res, 200, await ctx.git.push(root, remote ? { remote } : {}))
    return
  }
  if (route === '/checkout') {
    const branch = typeof body.branch === 'string' ? body.branch : ''
    if (!branch) throw new HttpError(400, 'branch is required')
    sendJson(res, 200, { ok: true, branch: await ctx.git.checkout(root, branch) })
    return
  }
  if (route === '/branch') {
    const branch = typeof body.name === 'string' ? body.name : ''
    sendJson(res, 200, { ok: true, branch: await ctx.git.createBranch(root, branch, body.checkout !== false) })
    return
  }
  throw new HttpError(404, 'not found')
}

function requirePath(ctx: Context, root: string, path: string | null) {
  if (!path) throw new HttpError(400, 'path is required')
  return ctx.workspace.resolvePath(path, root).path
}

function pathsOf(ctx: Context, root: string, value: unknown) {
  if (!Array.isArray(value)) throw new HttpError(400, 'paths is required')
  const paths = value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, 500)
    .map(path => ctx.workspace.resolvePath(path, root).path)
  if (!paths.length) throw new HttpError(400, 'paths is required')
  return paths
}

function numberParam(url: URL, name: string) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export default { name, inject, apply }

export const meta = {
  title: 'Git 接口',
  description: '提交、日志、差异、分支与远程同步的 HTTP 接口。',
}
