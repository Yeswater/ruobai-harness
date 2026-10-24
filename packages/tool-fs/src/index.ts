import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ToolDefinition } from '@ruobai/tools'

export interface Config {
  /** Filesystem boundary for every tool. Defaults to the process cwd. */
  root?: string
  /** Maximum bytes returned by read_file. */
  maxBytes?: number
}

const IGNORED = new Set(['node_modules', '.git', '.sessions', 'dist', 'lib'])

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

function resolveInside(root: string, path: unknown) {
  const target = resolve(root, typeof path === 'string' && path ? path : '.')
  if (!inside(root, target)) throw new Error(`path escapes the workspace: ${String(path)}`)
  return target
}

function tools(root: string, maxBytes: number): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
        required: ['path'],
      },
      async execute(args) {
        const target = resolveInside(root, args?.path)
        const info = await stat(target)
        if (!info.isFile()) throw new Error(`not a file: ${args?.path}`)
        if (info.size > maxBytes) throw new Error(`file is larger than ${maxBytes} bytes`)
        const content = await readFile(target, 'utf8')
        if (content.includes('\0')) throw new Error('binary files are not supported')
        return content
      },
    },
    {
      name: 'list_dir',
      description: 'List the entries of a directory inside the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory relative to the workspace root.' } },
        required: [],
      },
      async execute(args) {
        const target = resolveInside(root, args?.path)
        const entries = await readdir(target, { withFileTypes: true })
        return entries
          .filter(entry => !IGNORED.has(entry.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .slice(0, 200)
          .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
          .join('\n')
      },
    },
  ]
}

/** Read-only workspace tools. */
export default class FsTools {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    root: z.string().default('.'),
    maxBytes: z.number().min(1).default(65_536),
  })

  constructor(ctx: Context, config: Config) {
    const definitions = tools(resolve(config.root ?? '.'), config.maxBytes ?? 65_536)
    ctx.effect(() => {
      const disposers = definitions.map(definition => ctx.tools.register(definition))
      return () => disposers.forEach(dispose => dispose())
    }, 'ctx.tools.register(fs)')
  }
}

export { inside, resolveInside, tools }
