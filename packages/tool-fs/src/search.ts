import { opendir, readFile, stat } from 'node:fs/promises'
import { join, matchesGlob, relative, resolve, sep } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@ruobai/tools'

export interface SearchContext {
  fallbackRoot: string
  maxBytes: number
  ignored: ReadonlySet<string>
}

const EXTRA_IGNORED = ['coverage', '.next', '.turbo', '.cache', 'build', 'out']
const MAX_FILES = 20_000
const MAX_DEPTH = 20
const MAX_LINE = 500
const MAX_PATTERN = 500

interface WalkState {
  files: number
  done: boolean
}

function toPosix(root: string, target: string) {
  return relative(root, target).split(sep).join('/')
}

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

function resolveInside(root: string, path: unknown) {
  const target = resolve(root, typeof path === 'string' && path ? path : '.')
  if (!inside(root, target)) throw new Error(`path escapes the workspace: ${String(path)}`)
  return target
}

function rootFor(context: SearchContext, run?: ToolRunContext) {
  return run?.workspace ? resolve(run.workspace) : context.fallbackRoot
}

async function walk(
  dir: string,
  context: SearchContext,
  state: WalkState,
  depth: number,
  onFile: (target: string) => Promise<void>,
): Promise<void> {
  if (state.done || depth > MAX_DEPTH) return
  let handle
  try {
    handle = await opendir(dir)
  } catch {
    return
  }

  for await (const entry of handle) {
    if (state.done) return
    // Symlinks can escape the workspace or loop; ignore them.
    if (entry.isSymbolicLink()) continue
    const target = join(dir, entry.name)

    if (entry.isDirectory()) {
      if (context.ignored.has(entry.name) || EXTRA_IGNORED.includes(entry.name)) continue
      await walk(target, context, state, depth + 1, onFile)
      continue
    }

    if (!entry.isFile()) continue
    state.files += 1
    if (state.files > MAX_FILES) {
      state.done = true
      return
    }
    await onFile(target)
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function capped(value: number, fallback: number, max: number) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), max)
}

export function searchTools(context: SearchContext): ToolDefinition[] {
  return [
    {
      name: 'grep',
      description: [
        'Search file contents inside the workspace and return path:line:text matches.',
        'Skips ignored directories and binary files, caps results, and is read-only.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression, or a literal string when fixed is true.' },
          path: { type: 'string', description: 'Directory or file to search, relative to the workspace root.' },
          glob: { type: 'string', description: 'Only search files whose workspace-relative path matches this glob.' },
          caseSensitive: { type: 'boolean', description: 'Default true.' },
          fixed: { type: 'boolean', description: 'Treat pattern as a literal string instead of a regex.' },
          maxResults: { type: 'number', description: 'Default 200, capped at 500.' },
        },
        required: ['pattern'],
      },
      async execute(args, run) {
        const root = rootFor(context, run)
        const pattern = String(args?.pattern ?? '')
        if (!pattern) throw new Error('pattern is required')
        if (pattern.length > MAX_PATTERN) throw new Error(`pattern is longer than ${MAX_PATTERN} characters`)

        let matcher: RegExp
        try {
          matcher = new RegExp(args?.fixed ? escapeRegExp(pattern) : pattern, args?.caseSensitive === false ? 'i' : '')
        } catch (error) {
          throw new Error(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
        }

        const start = resolveInside(root, args?.path)
        const info = await stat(start).catch(() => undefined)
        if (!info) throw new Error(`path not found: ${args?.path}`)
        const maxResults = capped(args?.maxResults, 200, 500)
        const fileGlob = typeof args?.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined
        const matches: string[] = []
        let more = false

        const search = async (target: string) => {
          if (matches.length >= maxResults) {
            more = true
            return
          }
          const path = toPosix(root, target)
          if (fileGlob && !matchesGlob(path, fileGlob)) return

          const details = await stat(target)
          if (details.size > context.maxBytes) return
          const buffer = await readFile(target)
          if (buffer.includes(0)) return
          const text = buffer.toString('utf8')
          const lines = text.split('\n')
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]!
            if (!matcher.test(line)) continue
            matches.push(`${path}:${index + 1}:${line.slice(0, MAX_LINE).trimEnd()}`)
            if (matches.length >= maxResults) {
              more = true
              return
            }
          }
        }

        if (info.isFile()) await search(start)
        else await walk(start, context, { files: 0, done: false }, 0, search)

        if (!matches.length) return `No matches for ${args?.fixed ? JSON.stringify(pattern) : `/${pattern}/`}.`
        return more
          ? `${matches.join('\n')}\n… more matches were truncated at ${maxResults}`
          : matches.join('\n')
      },
    },
    {
      name: 'glob',
      description: [
        'List files inside the workspace whose path matches a glob.',
        'Read-only; use ** to cross directories and * within one segment.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob matched against workspace-relative paths, e.g. src/**/*.ts.' },
          path: { type: 'string', description: 'Directory to search, relative to the workspace root.' },
          maxResults: { type: 'number', description: 'Default 300, capped at 1000.' },
        },
        required: ['pattern'],
      },
      async execute(args, run) {
        const root = rootFor(context, run)
        const pattern = String(args?.pattern ?? '').trim()
        if (!pattern) throw new Error('pattern is required')
        if (pattern.length > MAX_PATTERN) throw new Error(`pattern is longer than ${MAX_PATTERN} characters`)
        if (pattern.includes('\0')) throw new Error('invalid pattern')

        const start = resolveInside(root, args?.path)
        const info = await stat(start).catch(() => undefined)
        if (!info) throw new Error(`path not found: ${args?.path}`)
        if (!info.isDirectory()) throw new Error(`not a directory: ${args?.path}`)

        const maxResults = capped(args?.maxResults, 300, 1_000)
        const files: string[] = []
        const state: WalkState = { files: 0, done: false }

        await walk(start, context, state, 0, async (target) => {
          const path = toPosix(root, target)
          if (!matchesGlob(path, pattern)) return
          files.push(path)
          if (files.length >= maxResults) state.done = true
        })

        files.sort()
        if (!files.length) return `No files matched ${pattern}.`
        return state.done && files.length >= maxResults
          ? `${files.join('\n')}\n… more files were truncated at ${maxResults}`
          : files.join('\n')
      },
    },
  ]
}
