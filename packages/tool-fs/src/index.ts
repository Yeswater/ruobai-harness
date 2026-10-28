import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ToolDefinition, ToolRunContext } from '@ruobai/tools'
import { createDiff } from './diff.ts'
import { searchTools } from './search.ts'

export interface Config {
  /** Filesystem boundary for every tool. Defaults to the process cwd. */
  root?: string
  /** Maximum bytes for a whole-file read or a single write. */
  maxBytes?: number
  /** Files up to this size can be edited/rewritten in one `edit_file` call. */
  maxEditBytes?: number
  /** Lines returned by a windowed `read_file`. */
  readWindowLines?: number
}

// `.ruobai` holds mutable harness data (checkpoints, wiki, scratch). Searching
// it duplicates every edited file through the checkpoint blob store.
const IGNORED = new Set(['node_modules', '.git', '.sessions', '.ruobai', 'dist', 'lib'])

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

const WINDOW_READ_LIMIT = 32 * 1024 * 1024
const MAX_WINDOW_CHARS = 2 * 1024 * 1024

/** Full reads stay small; anything bigger is served as a line window. */
async function readWindow(
  target: string,
  label: string,
  offset: number,
  limit: number,
  size: number,
): Promise<string> {
  if (size <= WINDOW_READ_LIMIT) {
    const buffer = await readFile(target)
    if (buffer.includes(0)) throw new Error('binary files are not supported')
    const lines = buffer.toString('utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    const total = lines.length
    const start = Math.min(Math.max(1, offset), total + 1)
    const slice = lines.slice(start - 1, start - 1 + limit)
    const end = start - 1 + slice.length
    const header = `[${label}: lines ${start}-${end} of ${total} | ${size} bytes`
      + `${end < total ? ` | next offset=${end + 1}` : ''}]`
    return truncateWindow([header, ...slice].join('\n'))
  }

  // Very large files: stream until the window is full. The total line count is
  // not known without reading to the end, so the header omits it.
  const stream = createReadStream(target, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const out: string[] = []
  let line = 0
  try {
    for await (const text of reader) {
      line += 1
      if (line < offset) continue
      out.push(text)
      if (out.length >= limit) break
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  if (!out.length) return `[${label}: no lines at offset ${offset} (${size} bytes)]`
  const end = offset + out.length - 1
  return truncateWindow([`[${label}: lines ${offset}-${end} | ${size} bytes | next offset=${end + 1}]`, ...out].join('\n'))
}

function truncateWindow(text: string): string {
  if (text.length <= MAX_WINDOW_CHARS) return text
  return `${text.slice(0, MAX_WINDOW_CHARS)}\n… window truncated; use a smaller limit or a later offset`
}

async function looksBinary(target: string): Promise<boolean> {
  const handle = await open(target, 'r')
  try {
    const head = Buffer.alloc(8_192)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return head.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
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

function bounded(value: unknown, name: string, min: number, max: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number`)
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function assertEditable(size: number, maxEditBytes: number, path: unknown) {
  if (size <= maxEditBytes) return
  throw new Error(
    `file is larger than ${maxEditBytes} bytes; edit_file rewrites the whole file. `
      + `Read it in ranges and use write_file, or raise maxEditBytes. (${String(path)})`,
  )
}

async function writeAtomic(target: string, content: string) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, target)
}

export interface CaptureInput {
  sessionId?: string
  path: string
  tool: string
  callId?: string
  before?: Buffer
  beforeExisted: boolean
  beforeBytes?: number
  skipped?: 'too-large' | 'unreadable'
  after: Buffer
  diff?: string
}

export type CaptureFn = (input: CaptureInput) => Promise<void>

interface Snapshot {
  buffer?: Buffer
  existed: boolean
  bytes?: number
  skipped?: 'too-large' | 'unreadable'
}

async function snapshot(target: string, maxBytes: number): Promise<Snapshot> {
  try {
    const info = await stat(target)
    if (!info.isFile()) return { existed: false }
    if (info.size > maxBytes) return { existed: true, bytes: info.size, skipped: 'too-large' }
    return { existed: true, bytes: info.size, buffer: await readFile(target) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false }
    return { existed: true, skipped: 'unreadable' }
  }
}

/**
 * In-process execution point for the sandbox guard table.
 *
 * Seatbelt only sees child processes, so `tool-fs` runs entirely outside the
 * kernel boundary. Without this check the `.git`, `.ssh` and `.env` guards
 * would hold for `bash` but not for `write_file`/`read_file`. Resolved lazily
 * so a sandbox mounted later (or unmounted) is honoured without a restart.
 */
export type GuardLookup = () => { check(path: string, access: 'read' | 'write'): void } | undefined

function guardCheck(lookup: GuardLookup | undefined, target: string, access: 'read' | 'write') {
  try {
    lookup?.()?.check(target, access)
  } catch (error) {
    // Surface as a tool error: the model must see the guard id and reason.
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function tools(
  fallbackRoot: string,
  maxBytes: number,
  maxEditBytes: number,
  readWindowLines: number,
  capture?: CaptureFn,
  guard?: GuardLookup,
): ToolDefinition[] {
  const rootFor = (run?: ToolRunContext) => run?.workspace ? resolve(run.workspace) : fallbackRoot

  const pathSubject = (args: any, run?: ToolRunContext) => {
    const root = rootFor(run)
    const target = resolveInside(root, args?.path)
    const path = relative(root, target).split(/[\\/]/).join('/')
    return path ? { kind: 'path' as const, value: path } : undefined
  }

  return [
    {
      name: 'read_file',
      description: [
        'Read a UTF-8 text file inside the workspace.',
        'A file larger than the byte cap is returned as a line window; pass offset/limit to page through it.',
      ].join(' '),
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          offset: { type: 'number', description: '1-based first line of the window.' },
          limit: { type: 'number', description: 'Lines in the window; default 2000, max 5000.' },
        },
        required: ['path'],
      },
      async execute(args, run) {
        const root = rootFor(run)
        const target = resolveInside(root, args?.path)
        guardCheck(guard, target, 'read')
        const info = await stat(target)
        if (!info.isFile()) throw new Error(`not a file: ${args?.path}`)
        const offset = args?.offset === undefined ? undefined : bounded(args.offset, 'offset', 1, 10_000_000)
        const limit = args?.limit === undefined ? undefined : bounded(args.limit, 'limit', 1, 5_000)

        if (offset === undefined && limit === undefined && info.size <= maxBytes) {
          const content = await readFile(target, 'utf8')
          if (content.includes('\0')) throw new Error('binary files are not supported')
          return content
        }

        if (await looksBinary(target)) throw new Error('binary files are not supported')
        const label = relative(root, target).split(/[\\/]/).join('/')
        return readWindow(target, label, offset ?? 1, limit ?? readWindowLines, info.size)
      },
    },
    {
      name: 'list_dir',
      description: 'List the entries of a directory inside the workspace.',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory relative to the workspace root.' } },
        required: [],
      },
      async execute(args, run) {
        const root = rootFor(run)
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
      description: [
        'Create or overwrite a UTF-8 text file inside the workspace. Requires user approval.',
        'Write temporary files to .ruobai/scratch/ so they never land in the source tree.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
      requiresApproval: true,
      approvalSubject: pathSubject,
      async preview(args, run) {
        const root = rootFor(run)
        const target = resolveInside(root, args?.path)
        const content = String(args?.content ?? '')
        const before = await readText(target)
        return {
          summary: `${args?.path} · ${before === undefined ? 'new file' : 'overwrite'} · ${Buffer.byteLength(content)} bytes`,
          diff: createDiff(before ?? '', content, String(args?.path)),
        }
      },
      async execute(args, run) {
        const root = rootFor(run)
        const target = resolveInside(root, args?.path)
        const content = String(args?.content ?? '')
        if (Buffer.byteLength(content) > maxBytes) throw new Error(`content is larger than ${maxBytes} bytes`)
        guardCheck(guard, target, 'write')
        const before = await snapshot(target, maxEditBytes)
        await writeAtomic(target, content)

        if (capture) {
          const beforeText = before.buffer && !before.buffer.includes(0)
            ? before.buffer.toString('utf8')
            : undefined
          await capture({
            sessionId: run?.sessionId,
            path: relative(root, target).split(/[\\/]/).join('/'),
            tool: 'write_file',
            callId: run?.callId,
            before: before.buffer,
            beforeExisted: before.existed,
            beforeBytes: before.bytes,
            skipped: before.skipped,
            after: Buffer.from(content),
            diff: createDiff(beforeText ?? '', content, String(args?.path)),
          })
        }

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
      approvalSubject: pathSubject,
      async preview(args, run) {
        const root = rootFor(run)
        const target = resolveInside(root, args?.path)
        const info = await stat(target).catch(() => undefined)
        if (!info?.isFile()) throw new Error(`not a text file: ${args?.path}`)
        assertEditable(info.size, maxEditBytes, args?.path)
        const before = await readText(target)
        if (before === undefined) throw new Error(`not a text file: ${args?.path}`)
        const after = replaceOnce(before, String(args?.oldText ?? ''), String(args?.newText ?? ''))
        if (Buffer.byteLength(after) > maxEditBytes) throw new Error(`result is larger than ${maxEditBytes} bytes`)
        return {
          summary: `${args?.path} · replace ${String(args?.oldText ?? '').length} chars`,
          diff: createDiff(before, after, String(args?.path)),
        }
      },
      async execute(args, run) {
        const root = rootFor(run)
        const target = resolveInside(root, args?.path)
        guardCheck(guard, target, 'write')
        const info = await stat(target).catch(() => undefined)
        if (!info?.isFile()) throw new Error(`not a text file: ${args?.path}`)
        assertEditable(info.size, maxEditBytes, args?.path)
        const before = await snapshot(target, maxEditBytes)
        const beforeText = before.buffer && !before.buffer.includes(0)
          ? before.buffer.toString('utf8')
          : await readText(target)
        if (beforeText === undefined) throw new Error(`not a text file: ${args?.path}`)
        const after = replaceOnce(beforeText, String(args?.oldText ?? ''), String(args?.newText ?? ''))
        if (Buffer.byteLength(after) > maxEditBytes) throw new Error(`result is larger than ${maxEditBytes} bytes`)
        await writeAtomic(target, after)

        if (capture) {
          await capture({
            sessionId: run?.sessionId,
            path: relative(root, target).split(/[\\/]/).join('/'),
            tool: 'edit_file',
            callId: run?.callId,
            before: before.buffer,
            beforeExisted: before.existed,
            beforeBytes: before.bytes,
            skipped: before.skipped,
            after: Buffer.from(after),
            diff: createDiff(beforeText, after, String(args?.path)),
          })
        }

        return `Edited ${args?.path}`
      },
    },
    ...searchTools({
      fallbackRoot,
      maxBytes,
      ignored: IGNORED,
    }),
  ]
}

/** Workspace tools; writes require approval. */
export default class FsTools {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    root: z.string().default('.'),
    maxBytes: z.number().min(1).default(65_536),
    maxEditBytes: z.number().min(1).default(8_388_608),
    readWindowLines: z.number().min(1).default(2_000),
  })

  constructor(ctx: Context, config: Config) {
    const capture: CaptureFn = async (input) => {
      if (!input.sessionId) return
      const checkpoints = ctx.get('checkpoints', false) as
        | { capture?(value: CaptureInput & { sessionId: string }): Promise<void> }
        | undefined
      if (!checkpoints?.capture) return
      try {
        await checkpoints.capture({ ...input, sessionId: input.sessionId })
      } catch (error) {
        ctx.logger('tool-fs').warn(error)
      }
    }

    const definitions = tools(
      resolve(config.root ?? '.'),
      config.maxBytes ?? 65_536,
      config.maxEditBytes ?? 8_388_608,
      config.readWindowLines ?? 2_000,
      capture,
      () => {
        // Optional: harness tests mount the fs tools without a sandbox, and a
        // hot-unloaded sandbox must stop guarding immediately.
        const policy = ctx.get('sandboxPolicy', false) as
          | { check?(path: string, access: 'read' | 'write'): void }
          | undefined
        if (!policy?.check) return undefined
        return { check: (path, access) => policy.check!(path, access) }
      },
    )
    ctx.effect(() => {
      const disposers = definitions.map(definition => ctx.tools.register(definition))
      return () => disposers.forEach(dispose => dispose())
    }, 'ctx.tools.register(fs)')
  }
}

export { createDiff, inside, resolveInside }

export const meta = {
  title: '文件工具',
  description: '读取、写入与搜索工作区文件。',
}
