import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type {} from '@ruobai/session'

export interface WorkspaceEntry {
  name: string
  /** POSIX-style path relative to the workspace root. */
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: WorkspaceEntry[]
}

export interface WorkspaceMatch {
  name: string
  path: string
  type: 'file' | 'directory'
}

export interface Config {
  root?: string
  maxBytes?: number
  maxDepth?: number
  maxEntries?: number
}

export class WorkspaceError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

declare module '@ruobai/cordis' {
  interface Context {
    workspace: WorkspaceService
  }
}

const IGNORED = new Set(['node_modules', '.git', '.sessions', 'dist', 'lib', 'coverage'])

/** Read-only view of one workspace root with traversal guards. */
export class WorkspaceService extends Service {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    root: z.string().default('.'),
    maxBytes: z.number().min(1).default(262_144),
    maxDepth: z.number().min(1).default(3),
    maxEntries: z.number().min(1).default(500),
  })

  readonly root: string

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'workspace')
    this.root = resolve(config.root ?? '.')
  }

  rootFor(sessionId?: string | null) {
    const workspace = sessionId ? this.ctx.sessions.get(sessionId)?.meta.workspace : undefined
    return workspace ? resolve(workspace) : this.root
  }

  resolvePath(path: unknown, root = this.root) {
    const target = resolve(root, typeof path === 'string' && path ? path : '.')
    const rel = relative(root, target)
    if (rel !== '' && (rel.startsWith('..') || rel.startsWith(sep))) {
      throw new WorkspaceError(403, `path escapes the workspace: ${String(path)}`)
    }
    if (rel.split(sep).includes('..')) throw new WorkspaceError(403, 'path escapes the workspace')
    return { target, path: rel.split(sep).join('/') }
  }

  async tree(path = '.', depth?: number, sessionId?: string): Promise<WorkspaceEntry> {
    const root = this.rootFor(sessionId)
    const resolved = this.resolvePath(path, root)
    const info = await stat(resolved.target).catch(() => undefined)
    if (!info) throw new WorkspaceError(404, `not found: ${String(path)}`)
    const prefix = resolved.path === '.' ? '' : resolved.path
    return this.entry(resolved.target, prefix, info.isDirectory(), depth ?? this.config.maxDepth ?? 3)
  }

  async read(path: unknown, sessionId?: string) {
    const root = this.rootFor(sessionId)
    const resolved = this.resolvePath(path, root)
    const info = await stat(resolved.target).catch(() => undefined)
    if (!info?.isFile()) throw new WorkspaceError(404, `not a file: ${String(path)}`)
    const maxBytes = this.config.maxBytes ?? 262_144
    if (info.size > maxBytes) throw new WorkspaceError(413, `file is larger than ${maxBytes} bytes`)
    const content = await readFile(resolved.target, 'utf8')
    if (content.includes('\0')) throw new WorkspaceError(415, 'binary files are not supported')
    return { path: resolved.path, size: info.size, content }
  }

  /** Directory-only listing for the workspace picker. */
  async browse(path?: string) {
    const target = path?.trim() ? resolve(path.trim()) : this.root
    const info = await stat(target).catch(() => undefined)
    if (!info?.isDirectory()) throw new WorkspaceError(404, `not a directory: ${path ?? target}`)
    const entries = (await readdir(target, { withFileTypes: true }))
      .filter(item => item.isDirectory() && !item.isSymbolicLink() && !IGNORED.has(item.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 500)
      .map(item => ({ name: item.name, path: join(target, item.name) }))
    const parent = dirname(target)
    return {
      path: target,
      parent: parent === target ? null : parent,
      home: homedir(),
      entries,
    }
  }

  /** Bounded workspace-relative file/directory search for `@` mentions. */
  async search(query: string, options: { limit?: number } = {}, sessionId?: string): Promise<WorkspaceMatch[]> {
    const root = this.rootFor(sessionId)
    const term = query.trim().toLowerCase().slice(0, 200)
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 20), 1), 50)
    const matches: WorkspaceMatch[] = []
    const maxVisited = 5_000
    let visited = 0

    const consider = (name: string, path: string, type: 'file' | 'directory') => {
      if (!term || name.toLowerCase().includes(term) || path.toLowerCase().includes(term)) {
        matches.push({ name, path, type })
      }
    }

    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (visited >= maxVisited || depth > 12) return
      const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (visited >= maxVisited) return
        if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue
        visited += 1
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          consider(entry.name, path, 'directory')
          // An empty query shows the top level only; typing searches deeper.
          if (term) await walk(resolve(dir, entry.name), path, depth + 1)
        } else if (entry.isFile()) {
          consider(entry.name, path, 'file')
        }
      }
    }

    await walk(root, '', 0)

    const score = (item: WorkspaceMatch) => {
      const name = item.name.toLowerCase()
      if (!term) return item.type === 'directory' ? 0 : 1
      if (name === term) return 0
      if (name.startsWith(term)) return 1
      if (name.includes(term)) return 2
      return 3
    }
    return matches
      .sort((a, b) => score(a) - score(b) || a.path.localeCompare(b.path))
      .slice(0, limit)
  }

  private async entry(target: string, path: string, directory: boolean, depth: number): Promise<WorkspaceEntry> {
    const name = path === '' ? '.' : path.split('/').at(-1)!
    if (!directory) {
      const info = await stat(target)
      return { name, path, type: 'file', size: info.size }
    }

    const children: WorkspaceEntry[] = []
    if (depth > 0) {
      const entries = (await readdir(target, { withFileTypes: true }))
        .filter(item => !IGNORED.has(item.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, this.config.maxEntries ?? 500)
      for (const item of entries) {
        const childPath = path ? `${path}/${item.name}` : item.name
        children.push(await this.entry(resolve(target, item.name), childPath, item.isDirectory(), depth - 1))
      }
    }
    return { name, path: path || '.', type: 'directory', children }
  }
}

export default WorkspaceService

export const meta = {
  title: '工作区服务',
  description: '受控读取工作区文件夹。',
}
