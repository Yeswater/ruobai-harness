import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { Context } from '@ruobai/cordis'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'
import { WorkspaceError } from '@ruobai/workspace'

export const name = 'workspace-web'
export const inject = ['web', 'workspace', 'sessions']

const run = promisify(execFile)

/** Absent query parameters must stay `undefined`, not become `Number(null) === 0`. */
function numberParam(url: URL, name: string) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Launch target for one detected editor or file manager. */
interface EditorCandidate {
  id: string
  name: string
  kind: 'editor' | 'folder'
  /** CLI on PATH. */
  command?: string
  args?: (target: string) => string[]
  /** macOS application name, used when the CLI is not installed. */
  app?: string
}

interface PublicEditor {
  id: string
  name: string
  kind: 'editor' | 'folder'
}

const EDITORS: EditorCandidate[] = [
  { id: 'vscode', name: 'VS Code', kind: 'editor', command: 'code', args: target => ['-g', target] },
  { id: 'vscode', name: 'VS Code', kind: 'editor', app: 'Visual Studio Code' },
  { id: 'cursor', name: 'Cursor', kind: 'editor', command: 'cursor', args: target => ['-g', target] },
  { id: 'cursor', name: 'Cursor', kind: 'editor', app: 'Cursor' },
  { id: 'windsurf', name: 'Windsurf', kind: 'editor', command: 'windsurf', args: target => ['-g', target] },
  { id: 'zed', name: 'Zed', kind: 'editor', command: 'zed', args: target => [target] },
  { id: 'zed', name: 'Zed', kind: 'editor', app: 'Zed' },
  { id: 'idea', name: 'IntelliJ IDEA', kind: 'editor', command: 'idea', args: target => [target] },
  { id: 'idea', name: 'IntelliJ IDEA', kind: 'editor', app: 'IntelliJ IDEA' },
  { id: 'idea', name: 'IntelliJ IDEA CE', kind: 'editor', app: 'IntelliJ IDEA CE' },
  { id: 'webstorm', name: 'WebStorm', kind: 'editor', command: 'webstorm', args: target => [target] },
  { id: 'webstorm', name: 'WebStorm', kind: 'editor', app: 'WebStorm' },
  { id: 'pycharm', name: 'PyCharm', kind: 'editor', command: 'pycharm', args: target => [target] },
  { id: 'pycharm', name: 'PyCharm', kind: 'editor', app: 'PyCharm' },
  { id: 'goland', name: 'GoLand', kind: 'editor', command: 'goland', args: target => [target] },
  { id: 'goland', name: 'GoLand', kind: 'editor', app: 'GoLand' },
  { id: 'sublime', name: 'Sublime Text', kind: 'editor', command: 'subl', args: target => [target] },
  { id: 'sublime', name: 'Sublime Text', kind: 'editor', app: 'Sublime Text' },
]

const EDITOR_CACHE_TTL = 60_000
let editorCache: { at: number; list: EditorCandidate[] } | undefined

/** Installed editors, detected once a minute. The file manager is universal. */
async function detectedEditors(): Promise<EditorCandidate[]> {
  if (editorCache && Date.now() - editorCache.at < EDITOR_CACHE_TTL) return editorCache.list
  const list: EditorCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of EDITORS) {
    if (seen.has(candidate.id)) continue
    const present = candidate.command
      ? await commandExists(candidate.command)
      : Boolean(candidate.app && macAppExists(candidate.app))
    if (!present) continue
    seen.add(candidate.id)
    list.push(candidate)
  }
  list.push({ id: 'system', name: process.platform === 'darwin' ? '访达' : '文件管理器', kind: 'folder' })
  editorCache = { at: Date.now(), list }
  return list
}

function macAppExists(app: string) {
  return existsSync(`/Applications/${app}.app`)
    || existsSync(`${homedir()}/Applications/${app}.app`)
}

function publicEditors(list: EditorCandidate[]): PublicEditor[] {
  const seen = new Set<string>()
  return list
    .filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .map(({ id, name, kind }) => ({ id, name, kind }))
}

function launchEditor(candidate: EditorCandidate, target: string) {
  if (candidate.command) {
    launch(candidate.command, candidate.args?.(target) ?? [target])
  } else if (candidate.app) {
    launch('open', ['-a', candidate.app, target])
  } else if (process.platform === 'darwin') {
    launch('open', [target])
  } else if (process.platform === 'win32') {
    launch('cmd', ['/c', 'start', '', target])
  } else {
    launch('xdg-open', [target])
  }
  return candidate.id
}

/** Exposes the read-only workspace service and editor launching. */
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

    if (url.pathname === '/api/workspace/open') {
      await openFile(ctx, req, res)
      return true
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }

    if (url.pathname === '/api/workspace/editors') {
      sendJson(res, 200, { editors: publicEditors(await detectedEditors()) })
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
    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    const status = error instanceof WorkspaceError ? error.status : error instanceof HttpError ? error.status : 500
    if (status === 500) ctx.logger('workspace-web').error(error)
    sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
  }
  return true
}

async function openFile(ctx: Context, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
  const body = await readJson(req)
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!sessionId || !ctx.sessions.has(sessionId)) throw new HttpError(400, 'sessionId is required')
  const root = ctx.workspace.rootFor(sessionId)
  const path = typeof body.path === 'string' ? body.path.trim() : ''
  const target = path ? ctx.workspace.resolvePath(path, root).target : root
  const editorId = typeof body.editor === 'string' ? body.editor.trim() : ''

  const editors = await detectedEditors()
  const candidate = editorId
    ? editors.find(item => item.id === editorId)
    : editors.find(item => item.kind === 'editor') ?? editors.find(item => item.id === 'system')
  if (editorId && !candidate) throw new HttpError(400, `unknown editor: ${editorId}`)
  if (!candidate) throw new HttpError(400, 'no editor available')
  sendJson(res, 200, { ok: true, opened: launchEditor(candidate, target) })
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
  description: '提供文件树、文件读取、编辑器打开与内容搜索接口。',
}
