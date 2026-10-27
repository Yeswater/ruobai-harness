import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import type { Context } from '@ruobai/cordis'
import { GiteeError, PublishError, type PublishInput } from '@ruobai/gitee'
import { SettingsError } from '@ruobai/settings'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'gitee-web'
export const inject = ['web', 'gitee', 'settings', 'workspace', 'sessions', 'git']

/** HTTP adapter for the Gitee service; the browser never sees the token. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/gitee',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'gitee-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const route = url.pathname.slice('/api/gitee'.length) || '/'

    if (req.method === 'GET') {
      if (route === '/status') {
        sendJson(res, 200, await status(ctx, url))
        return true
      }
      await read(ctx, res, url, route)
      return true
    }

    if (req.method === 'PUT' && route === '/settings') {
      const body = await readJson(req)
      await ctx.settings.updateGitee(normalizePatch(body))
      sendJson(res, 200, ctx.settings.publicGitee())
      return true
    }

    if (req.method === 'POST' && (route === '/publish/preview' || route === '/publish')) {
      const body = await readJson(req) as Record<string, unknown>
      const root = workspaceFor(ctx, body.sessionId)
      const input = publishInput(body, root)
      sendJson(res, 200, route === '/publish/preview'
        ? await ctx.gitee.planPublish(input)
        : await ctx.gitee.publish(input))
      return true
    }

    const issue = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(route)
    if (req.method === 'POST' && issue) {
      const body = await readJson(req) as Record<string, unknown>
      const owner = segment(issue[1]!, 'owner')
      const repo = segment(issue[2]!, 'repo')
      const action = typeof body.action === 'string' ? body.action : 'create'
      if (action === 'create') {
        sendJson(res, 200, await ctx.gitee.createIssue(owner, repo, {
          title: typeof body.title === 'string' ? body.title : '',
          body: typeof body.body === 'string' ? body.body : undefined,
          labels: Array.isArray(body.labels)
            ? body.labels.map(String)
            : typeof body.labels === 'string' ? body.labels.split(',') : undefined,
        }))
      } else if (action === 'comment') {
        await ctx.gitee.commentIssue(
          owner,
          repo,
          issueNumber(String(body.number ?? '')),
          typeof body.body === 'string' ? body.body : '',
        )
        sendJson(res, 200, { ok: true })
      } else if (action === 'close') {
        sendJson(res, 200, await ctx.gitee.closeIssue(
          owner,
          repo,
          issueNumber(String(body.number ?? '')),
        ))
      } else {
        throw new HttpError(400, 'unknown action')
      }
      return true
    }

    const pull = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(route)
    if (req.method === 'POST' && pull) {
      const body = await readJson(req) as Record<string, unknown>
      const owner = segment(pull[1]!, 'owner')
      const repo = segment(pull[2]!, 'repo')
      const action = typeof body.action === 'string' ? body.action : 'create'
      if (action === 'create') {
        sendJson(res, 200, await ctx.gitee.createPull(owner, repo, {
          title: typeof body.title === 'string' ? body.title : '',
          head: typeof body.head === 'string' ? body.head : '',
          base: typeof body.base === 'string' ? body.base : '',
          body: typeof body.body === 'string' ? body.body : undefined,
        }))
      } else if (action === 'comment') {
        await ctx.gitee.commentPull(
          owner,
          repo,
          issueNumber(String(body.number ?? '')),
          typeof body.body === 'string' ? body.body : '',
        )
        sendJson(res, 200, { ok: true })
      } else {
        throw new HttpError(400, 'unknown action')
      }
      return true
    }

    const release = /^\/repos\/([^/]+)\/([^/]+)\/releases$/.exec(route)
    if (req.method === 'POST' && release) {
      const body = await readJson(req) as Record<string, unknown>
      sendJson(res, 200, await ctx.gitee.createRelease(
        segment(release[1]!, 'owner'),
        segment(release[2]!, 'repo'),
        {
          tagName: typeof body.tagName === 'string' ? body.tagName : '',
          name: typeof body.name === 'string' ? body.name : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
          target: typeof body.target === 'string' ? body.target : undefined,
        },
      ))
      return true
    }

    if (req.method === 'POST' && route === '/test') {
      const body = await readJson(req).catch(() => ({})) as { token?: unknown }
      const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : undefined
      sendJson(res, 200, { account: await ctx.gitee.account(token) })
      return true
    }

    throw new HttpError(405, 'method not allowed')
  } catch (error) {
    if (error instanceof PublishError) {
      sendJson(res, 502, { error: error.message, steps: error.steps })
      return true
    }
    const status = error instanceof HttpError
      ? error.status
      : error instanceof SettingsError
        ? error.status
        : error instanceof GiteeError
          ? error.status >= 400 && error.status < 500 ? error.status : 502
          : 500
    if (status >= 500) ctx.logger('gitee-web').error(error)
    sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
  }
  return true
}

async function status(ctx: Context, url: URL) {
  const root = workspaceFor(ctx, url.searchParams.get('sessionId'))
  const info = await ctx.git.info(root)
  const account = ctx.gitee.configured()
    ? await ctx.gitee.account().catch(() => undefined)
    : undefined
  return {
    workspace: root,
    suggestedRepo: basename(root),
    ...(account?.login ? { accountLogin: account.login } : {}),
    branch: info.branch,
    head: info.head,
    dirty: info.files > 0,
    remotes: await ctx.git.remotes(root),
  }
}

function workspaceFor(ctx: Context, sessionId: unknown) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new HttpError(400, 'sessionId is required')
  }
  if (!ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')
  return ctx.workspace.rootFor(sessionId)
}

function publishInput(body: Record<string, unknown>, workspace: string): PublishInput {
  const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
  if (!repo) throw new HttpError(400, 'repo is required')
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
  return {
    workspace,
    owner: text(body.owner),
    repo,
    branch: text(body.branch),
    private: typeof body.private === 'boolean' ? body.private : undefined,
    description: text(body.description),
    tag: text(body.tag),
    ...(typeof body.releaseTitle === 'string' ? { releaseTitle: body.releaseTitle } : {}),
    ...(typeof body.releaseBody === 'string' ? { releaseBody: body.releaseBody } : {}),
    remoteName: text(body.remoteName),
  }
}

async function read(ctx: Context, res: ServerResponse, url: URL, route: string) {
  if (route === '/settings') {
    sendJson(res, 200, ctx.settings.publicGitee())
    return
  }

  if (route === '/repos') {
    sendJson(res, 200, await ctx.gitee.listRepos({
      query: url.searchParams.get('query') ?? undefined,
      page: numberParam(url, 'page'),
    }))
    return
  }

  const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(branches|commits|contents|releases|issues|pulls)(?:\/(\d+))?)?$/.exec(route)
  if (!match) throw new HttpError(404, 'not found')

  const owner = segment(match[1]!, 'owner')
  const repo = segment(match[2]!, 'repo')
  const section = match[3]
  const number = match[4]

  if (!section) {
    sendJson(res, 200, await ctx.gitee.getRepo(owner, repo))
    return
  }

  if (section === 'branches') {
    sendJson(res, 200, await ctx.gitee.branches(owner, repo, numberParam(url, 'page')))
    return
  }
  if (section === 'commits') {
    sendJson(res, 200, await ctx.gitee.commits(owner, repo, {
      ref: url.searchParams.get('ref') ?? undefined,
      path: url.searchParams.get('path') ?? undefined,
      page: numberParam(url, 'page'),
    }))
    return
  }
  if (section === 'contents') {
    sendJson(res, 200, await ctx.gitee.contents(owner, repo, {
      path: url.searchParams.get('path') ?? undefined,
      ref: url.searchParams.get('ref') ?? undefined,
    }))
    return
  }
  if (section === 'releases' && !number) {
    sendJson(res, 200, await ctx.gitee.releases(owner, repo, numberParam(url, 'page')))
    return
  }
  if (section === 'issues' && !number) {
    sendJson(res, 200, await ctx.gitee.issues(owner, repo, {
      state: url.searchParams.get('state') ?? undefined,
      page: numberParam(url, 'page'),
    }))
    return
  }
  if (section === 'issues' && number) {
    sendJson(res, 200, await ctx.gitee.issue(owner, repo, issueNumber(number)))
    return
  }
  if (section === 'pulls' && !number) {
    sendJson(res, 200, await ctx.gitee.pulls(owner, repo, {
      state: url.searchParams.get('state') ?? undefined,
      page: numberParam(url, 'page'),
    }))
    return
  }
  if (section === 'pulls' && number) {
    sendJson(res, 200, await ctx.gitee.pull(owner, repo, issueNumber(number)))
    return
  }
  throw new HttpError(404, 'not found')
}

function normalizePatch(body: unknown): {
  token?: string
  clearToken?: boolean
  owner?: string
  apiBase?: string
  visibility?: 'public' | 'private'
} {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  return {
    ...(typeof input.token === 'string' ? { token: input.token } : {}),
    ...(input.clearToken === true ? { clearToken: true } : {}),
    ...(typeof input.owner === 'string' ? { owner: input.owner } : {}),
    ...(typeof input.apiBase === 'string' ? { apiBase: input.apiBase } : {}),
    ...(input.visibility === 'public' || input.visibility === 'private'
      ? { visibility: input.visibility }
      : {}),
  }
}

function segment(value: string, field: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new HttpError(400, `invalid ${field}`)
  }
  if (!/^[A-Za-z0-9._-]{1,191}$/.test(decoded) || decoded === '.' || decoded === '..') {
    throw new HttpError(400, `invalid ${field}`)
  }
  return decoded
}

function numberParam(url: URL, key: string) {
  const raw = url.searchParams.get(key)
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function issueNumber(raw: string) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new HttpError(400, 'invalid number')
  return value
}

export default { name, inject, apply }

export const meta = {
  title: 'Gitee 接口',
  description: '提供 Gitee 设置与只读仓库接口。',
}
