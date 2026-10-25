import { execFile, spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
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
  /** Commits ahead of the upstream branch, when one is configured. */
  ahead?: number
  behind?: number
}

/** One entry of `git status`, shaped for the source-control panel. */
export interface GitFile {
  path: string
  /** Single-letter porcelain status: M A D R C U ? */
  status: string
  staged: boolean
}

const MAX_DIFF_CHARS = 200_000

const run = promisify(execFile)

function git(root: string, args: string[]) {
  return run('git', ['-C', root, ...args], { timeout: 5_000, maxBuffer: 1_000_000 })
}

function errorText(error: unknown) {
  const output = error as { stderr?: string; stdout?: string; message?: string }
  const detail = output.stderr?.trim() || output.stdout?.trim() || output.message || 'git failed'
  return detail.split('\n')[0]!.slice(0, 300)
}

/** Absent query parameters must stay `undefined`, not become `Number(null) === 0`. */
function numberParam(url: URL, name: string) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
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

/** Upstream divergence; omitted when the branch has no upstream. */
async function divergence(root: string) {
  try {
    const output = (await git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).stdout.trim()
    const [behind, ahead] = output.split(/\s+/).map(Number)
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return {}
    return { ahead, behind }
  } catch {
    return {}
  }
}

/**
 * `git status --porcelain=v1 -z`: NUL-separated `XY path` records, where a
 * rename or copy is followed by a record holding the original path.
 */
function parseStatus(output: string): GitFile[] {
  const records = output.split('\0')
  const files: GitFile[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const x = record[0]!
    const y = record[1]!
    const path = record.slice(3)
    if (x === 'R' || x === 'C') index += 1
    if (!path) continue
    const staged = x !== ' ' && x !== '?'
    const status = x === '?' ? '?' : y !== ' ' ? y : x
    files.push({ path, status, staged })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return files
}

async function gitFiles(root: string) {
  const output = (await git(root, ['status', '--porcelain=v1', '-z'])).stdout
  return parseStatus(output)
}

/**
 * Diff of one path against HEAD. Untracked files have no HEAD entry, so they
 * are diffed against /dev/null to still show their contents.
 */
async function gitFileDiff(root: string, relative: string) {
  const target = resolve(root, relative)
  const rel = target === root ? '' : target.slice(root.length + 1)
  if (!rel || rel.startsWith('..')) throw new HttpError(400, `path escapes the workspace: ${relative}`)

  let output = ''
  try {
    output = (await git(root, ['diff', 'HEAD', '--no-color', '--', rel])).stdout
  } catch {
    output = ''
  }
  if (!output.trim()) {
    try {
      output = (await git(root, ['diff', '--no-index', '--no-color', '--', '/dev/null', rel])).stdout
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? ''
    }
  }
  return {
    path: rel,
    diff: output.length > MAX_DIFF_CHARS ? `${output.slice(0, MAX_DIFF_CHARS)}\n… 已截断` : output,
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
    return { available: true, branch, workspace: root, home, files, added, removed, ...await divergence(root) }
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

    if (url.pathname === '/api/workspace/open') {
      await openFile(ctx, req, res)
      return true
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }

    if (url.pathname === '/api/workspace/tree') {
      const depthParam = numberParam(url, 'depth')
      const depth = depthParam !== undefined && depthParam > 0 ? Math.floor(depthParam) : undefined
      const compact = ['1', 'true', 'yes'].includes(
        (url.searchParams.get('compact') ?? '').toLowerCase(),
      )
      const tree = await ctx.workspace.tree(
        url.searchParams.get('path') ?? '.',
        depth,
        sessionId,
        compact,
      )
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
      const files = await ctx.workspace.search(query, { limit: numberParam(url, 'limit') }, sessionId)
      sendJson(res, 200, { files })
      return true
    }
    if (url.pathname === '/api/workspace/grep') {
      const query = (url.searchParams.get('q') ?? '').slice(0, 200)
      const matches = await ctx.workspace.grep(query, { limit: numberParam(url, 'limit') }, sessionId)
      sendJson(res, 200, { matches })
      return true
    }
    if (url.pathname === '/api/workspace/git') {
      sendJson(res, 200, await gitInfo(ctx.workspace.rootFor(sessionId)))
      return true
    }
    if (url.pathname === '/api/workspace/git/files') {
      const root = ctx.workspace.rootFor(sessionId)
      const files = await gitFiles(root).catch(() => [])
      sendJson(res, 200, { files })
      return true
    }
    if (url.pathname === '/api/workspace/git/diff') {
      const path = url.searchParams.get('path')
      if (!path) throw new HttpError(400, 'path is required')
      const root = ctx.workspace.rootFor(sessionId)
      const relative = ctx.workspace.resolvePath(path, root).path
      sendJson(res, 200, await gitFileDiff(root, relative))
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
  const paths = Array.isArray(body.paths)
    ? body.paths
      .filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
      .slice(0, 500)
    : []
  try {
    if (paths.length) {
      const relative = paths.map(item => ctx.workspace.resolvePath(item, root).path)
      await git(root, ['add', '-A', '--', ...relative])
      // Committing with a pathspec leaves the user's other staged work alone.
      const result = await git(root, ['commit', '-m', message, '--', ...relative])
      sendJson(res, 200, { ok: true, commit: result.stdout.split('\n')[0]?.trim() ?? '' })
      return
    }
    await git(root, ['add', '-A'])
    const result = await git(root, ['commit', '-m', message])
    sendJson(res, 200, { ok: true, commit: result.stdout.split('\n')[0]?.trim() ?? '' })
  } catch (error) {
    throw new HttpError(400, errorText(error))
  }
}

async function openFile(ctx: Context, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
  const body = await readJson(req)
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!sessionId || !ctx.sessions.has(sessionId)) throw new HttpError(400, 'sessionId is required')
  const path = typeof body.path === 'string' ? body.path : ''
  if (!path) throw new HttpError(400, 'path is required')

  const target = ctx.workspace.resolvePath(path, ctx.workspace.rootFor(sessionId)).target
  sendJson(res, 200, { ok: true, opened: await openInEditor(target) })
}

/** Prefer an editor CLI when installed; otherwise hand the file to the OS. */
async function openInEditor(target: string) {
  const editors: Array<[string, string[]]> = [
    ['code', ['-g', target]],
    ['cursor', ['-g', target]],
    ['zed', [target]],
  ]
  for (const [command, args] of editors) {
    // `execFile` must go through the promisified runner: a raw ChildProcess
    // resolves immediately, so a missing editor would be spawned unchecked.
    if (!(await commandExists(command))) continue
    launch(command, args)
    return command
  }
  const [command, args] = process.platform === 'darwin'
    ? ['open', ['-t', target]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : ['xdg-open', [target]]
  launch(command, args)
  return 'system'
}

async function commandExists(command: string) {
  try {
    await run(command, ['--version'], { timeout: 2_000 })
    return true
  } catch {
    return false
  }
}

/** A failed spawn reports through `error`; without a listener Node exits. */
function launch(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

export default { name, inject, apply }

export const meta = {
  title: '工作区接口',
  description: '提供文件树、文件读取、编辑器打开与 Git 状态接口。',
}
