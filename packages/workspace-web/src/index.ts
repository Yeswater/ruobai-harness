import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { Context } from '@ruobai/cordis'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'
import { WorkspaceError } from '@ruobai/workspace'

export const name = 'workspace-web'
export const inject = ['web', 'workspace', 'sessions']

export interface GitInfo {
  /** The workspace root resolves inside a Git repository. */
  available: boolean
  branch: string | null
  workspace: string
  home: string
  files: number
  added: number
  removed: number
}

const run = promisify(execFile)

function git(root: string, args: string[]) {
  return run('git', ['-C', root, ...args], { timeout: 5_000, maxBuffer: 1_000_000 })
}

function errorText(error: unknown) {
  const output = error as { stderr?: string; stdout?: string; message?: string }
  const detail = output.stderr?.trim() || output.stdout?.trim() || output.message || 'git failed'
  return detail.split('\n')[0]!.slice(0, 300)
}

async function currentBranch(root: string) {
  try {
    return (await git(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim() || null
  } catch {
    try {
      return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || null
    } catch {
      return null
    }
  }
}

/** Tracked-line stats against HEAD, falling back to a repo without commits. */
async function numstat(root: string) {
  try {
    return (await git(root, ['diff', '--numstat', 'HEAD'])).stdout
  } catch {
    const [unstaged, staged] = await Promise.all([
      git(root, ['diff', '--numstat']).then(result => result.stdout).catch(() => ''),
      git(root, ['diff', '--cached', '--numstat']).then(result => result.stdout).catch(() => ''),
    ])
    return unstaged + staged
  }
}

async function gitInfo(root: string): Promise<GitInfo> {
  const home = homedir()
  const branch = await currentBranch(root)
  if (!branch) {
    return { available: false, branch: null, workspace: root, home, files: 0, added: 0, removed: 0 }
  }
  try {
    const status = await git(root, ['status', '--porcelain=v1'])
    const files = status.stdout.split('\n').filter(Boolean).length
    let added = 0
    let removed = 0
    for (const line of (await numstat(root)).split('\n')) {
      const [plus, minus] = line.split('\t')
      if (!plus || !minus) continue
      if (Number.isFinite(Number(plus))) added += Number(plus)
      if (Number.isFinite(Number(minus))) removed += Number(minus)
    }
    return { available: true, branch, workspace: root, home, files, added, removed }
  } catch {
    return { available: true, branch, workspace: root, home, files: 0, added: 0, removed: 0 }
  }
}

/** Exposes the read-only workspace service and Git working-tree actions. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/workspace',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'workspace-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')

    if (url.pathname === '/api/workspace/commit') {
      await commit(ctx, req, res)
      return true
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }

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
    if (url.pathname === '/api/workspace/search') {
      const query = (url.searchParams.get('q') ?? '').slice(0, 200)
      const limitValue = Number(url.searchParams.get('limit'))
      const files = await ctx.workspace.search(
        query,
        { limit: Number.isFinite(limitValue) ? limitValue : undefined },
        sessionId,
      )
      sendJson(res, 200, { files })
      return true
    }
    if (url.pathname === '/api/workspace/git') {
      sendJson(res, 200, await gitInfo(ctx.workspace.rootFor(sessionId)))
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

async function commit(ctx: Context, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
  const body = await readJson(req)
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!sessionId || !ctx.sessions.has(sessionId)) throw new HttpError(400, 'sessionId is required')
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) throw new HttpError(400, 'message is required')

  const root = ctx.workspace.rootFor(sessionId)
  try {
    await git(root, ['add', '-A'])
    const result = await git(root, ['commit', '-m', message])
    sendJson(res, 200, { ok: true, commit: result.stdout.split('\n')[0]?.trim() ?? '' })
  } catch (error) {
    throw new HttpError(400, errorText(error))
  }
}

export default { name, inject, apply }
