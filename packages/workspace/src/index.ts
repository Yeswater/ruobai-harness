import { readFile, readdir, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

export interface WorkspaceEntry {
  name: string
  /** POSIX-style path relative to the workspace root. */
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: WorkspaceEntry[]
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

  resolvePath(path: unknown) {
    const target = resolve(this.root, typeof path === 'string' && path ? path : '.')
    const rel = relative(this.root, target)
    if (rel !== '' && (rel.startsWith('..') || rel.startsWith(sep))) {
      throw new WorkspaceError(403, `path escapes the workspace: ${String(path)}`)
    }
    if (rel.split(sep).includes('..')) throw new WorkspaceError(403, 'path escapes the workspace')
    return { target, path: rel.split(sep).join('/') }
  }

  async tree(path = '.', depth?: number): Promise<WorkspaceEntry> {
    const resolved = this.resolvePath(path)
    const info = await stat(resolved.target).catch(() => undefined)
    if (!info) throw new WorkspaceError(404, `not found: ${String(path)}`)
    const prefix = resolved.path === '.' ? '' : resolved.path
    return this.entry(resolved.target, prefix, info.isDirectory(), depth ?? this.config.maxDepth ?? 3)
  }

  async read(path: unknown) {
    const resolved = this.resolvePath(path)
    const info = await stat(resolved.target).catch(() => undefined)
    if (!info?.isFile()) throw new WorkspaceError(404, `not a file: ${String(path)}`)
    const maxBytes = this.config.maxBytes ?? 262_144
    if (info.size > maxBytes) throw new WorkspaceError(413, `file is larger than ${maxBytes} bytes`)
    const content = await readFile(resolved.target, 'utf8')
    if (content.includes('\0')) throw new WorkspaceError(415, 'binary files are not supported')
    return { path: resolved.path, size: info.size, content }
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
