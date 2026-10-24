import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ToolDefinition } from '@ruobai/tools'
import { createDiff } from './diff.ts'

export interface Config {
  /** Filesystem boundary for every tool. Defaults to the process cwd. */
  root?: string
  /** Maximum bytes read or written in one call. */
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

async function readText(target: string): Promise<string | undefined> {
  try {
    const info = await stat(target)
    if (!info.isFile()) return undefined
    const content = await readFile(target, 'utf8')
    return content.includes('\0') ? undefined : content
  } catch {
    return undefined
  }
}

function replaceOnce(before: string, oldText: string, newText: string) {
  const index = before.indexOf(oldText)
  if (index < 0) throw new Error('oldText was not found in the file')
  if (before.indexOf(oldText, index + oldText.length) >= 0) {
    throw new Error('oldText appears more than once; include more context')
  }
  return before.slice(0, index) + newText + before.slice(index + oldText.length)
}

async function writeAtomic(target: string, content: string) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, target)
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
    {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file inside the workspace. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
      requiresApproval: true,
      async preview(args) {
        const target = resolveInside(root, args?.path)
        const content = String(args?.content ?? '')
        const before = await readText(target)
        return {
          summary: `${args?.path} · ${before === undefined ? 'new file' : 'overwrite'} · ${Buffer.byteLength(content)} bytes`,
          diff: createDiff(before ?? '', content, String(args?.path)),
        }
      },
      async execute(args) {
        const target = resolveInside(root, args?.path)
        const content = String(args?.content ?? '')
        if (Buffer.byteLength(content) > maxBytes) throw new Error(`content is larger than ${maxBytes} bytes`)
        await writeAtomic(target, content)
        return `Wrote ${Buffer.byteLength(content)} bytes to ${args?.path}`
      },
    },
    {
      name: 'edit_file',
      description: 'Replace exactly one occurrence of oldText with newText in a workspace file. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          oldText: { type: 'string', description: 'Exact text to replace; must occur once.' },
          newText: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'oldText', 'newText'],
      },
      requiresApproval: true,
      async preview(args) {
        const target = resolveInside(root, args?.path)
        const before = await readText(target)
        if (before === undefined) throw new Error(`not a text file: ${args?.path}`)
        const after = replaceOnce(before, String(args?.oldText ?? ''), String(args?.newText ?? ''))
        if (Buffer.byteLength(after) > maxBytes) throw new Error(`result is larger than ${maxBytes} bytes`)
        return {
          summary: `${args?.path} · replace ${String(args?.oldText ?? '').length} chars`,
          diff: createDiff(before, after, String(args?.path)),
        }
      },
      async execute(args) {
        const target = resolveInside(root, args?.path)
        const before = await readText(target)
        if (before === undefined) throw new Error(`not a text file: ${args?.path}`)
        const after = replaceOnce(before, String(args?.oldText ?? ''), String(args?.newText ?? ''))
        if (Buffer.byteLength(after) > maxBytes) throw new Error(`result is larger than ${maxBytes} bytes`)
        await writeAtomic(target, after)
        return `Edited ${args?.path}`
      },
    },
  ]
}

/** Workspace tools; writes require approval. */
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

export { createDiff, inside, resolveInside }
