import type { ToolBlock } from '@ruobai/chat-protocol'

interface Bucket {
  names: string[]
  /** Label shown before the dot in a folded row ("运行命令"). */
  row: string
}

/**
 * Tools are reported by name; the rows say what the user cares about instead of
 * echoing the internal tool id.
 */
const BUCKETS: Bucket[] = [
  { row: '运行命令', names: ['bash', 'run_command', 'shell', 'execute_command'] },
  { row: '调用子智能体', names: ['task', 'delegate', 'subagent'] },
  { row: '读取文件', names: ['read_file', 'read', 'view_file'] },
  { row: '创建文件', names: ['write_file', 'create_file', 'write'] },
  { row: '编辑文件', names: ['edit_file', 'apply_patch', 'edit', 'multi_edit'] },
  { row: '查看目录', names: ['list_dir', 'list_files', 'list_directory'] },
  { row: '搜索', names: ['search_files', 'grep', 'glob', 'search'] },
]

const OTHER: Bucket = { names: [], row: '其他操作' }

function bucketOf(name: string) {
  const lower = name.toLowerCase()
  // MCP / A2A tools are `mcp__<server>__<tool>`; they fall to the catch-all
  // label, not to a file or shell verb.
  return BUCKETS.find(bucket => bucket.names.includes(lower)) ?? OTHER
}

function parseInput(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function firstLine(text: string, limit = 80) {
  const line = text.split('\n').find(item => item.trim())?.trim() ?? text.trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Last two segments keep same-named files distinguishable without the full path. */
function shortPath(path: string) {
  return path.split('/').filter(Boolean).slice(-2).join('/') || path
}

/** A Claude Code-style short title for a shell command. */
export function describeCommand(command: string): string {
  // Common shape: `cd <dir> && grep …`. The leading cd is navigation, not the
  // action the row is about.
  const normalized = command.trim().replace(/^(?:cd\s+\S+\s*&&\s*)+/, '')
  const words = normalized.split(/\s+/)
  const head = basename(words[0] ?? '')
  const restWords = words.slice(1)
  const rest = restWords
  const value = (index: number) => rest[index]?.replace(/^['"]|['"]$/g, '') ?? ''
  const firstValue = rest.find(word => !word.startsWith('-'))
  if (/^(grep|rg|ag)$/.test(head)) return firstValue ? `搜索 "${firstValue}"` : '搜索'
  if (/^(find|fd)$/.test(head)) return '查找文件'
  if (/^(ls|tree)$/.test(head)) return '查看目录'
  if (/^(sed|cat|head|tail|less|nl|bat|wc)$/.test(head)) {
    const file = [...rest].reverse().find(word => !word.startsWith('-') && !word.startsWith('+'))
    return file ? `查看 ${basename(file.replace(/^['"]|['"]$/g, ''))}` : '查看文件'
  }
  if (/^(pnpm|npm|npx|yarn|bun)$/.test(head)) return `运行 ${[head, value(0)].filter(Boolean).join(' ')}`
  if (head === 'node') return `运行 node ${value(0)}`
  if (head === 'git') return `运行 git ${value(0)}`
  if (/^(curl|wget)$/.test(head)) return `请求 ${firstValue ?? ''}`.trim()
  if (/^(echo|printf)$/.test(head)) return '输出文本'
  return '运行命令'
}

function pathOf(input: Record<string, unknown> | undefined) {
  const value = input?.path ?? input?.file_path ?? input?.file ?? input?.target
  return typeof value === 'string' ? value : undefined
}

export interface ToolDetail {
  /** Verb shown before the dot in a folded row ("运行命令"). */
  row: string
  /** Short action title, e.g. `搜索 "process"` or `查看 Transcript.tsx`. */
  title: string
  /** Gist shown after the dot. */
  summary: string
  /** Shell command, shown on its own line above the output. */
  command?: string
  /** File or directory the call touched. */
  path?: string
}

/** One folded row for a single call: verb + the thing it acted on. */
export function toolDetail(block: ToolBlock): ToolDetail {
  const input = parseInput(block.input)
  const path = pathOf(input)
  const name = block.name.toLowerCase()
  const row = bucketOf(name).row

  if (name === 'bash' || name === 'run_command' || name === 'shell') {
    const raw = input?.command ?? input?.cmd
    if (typeof raw !== 'string') return { row: '运行命令', title: '运行命令', summary: '' }
    // Claude Code asks the model for a short action title; use it when present
    // and fall back to a verb derived from the command.
    const described = typeof input?.description === 'string' ? firstLine(input.description, 48) : ''
    // The full command is shown in the body; the row only needs its gist.
    return { row: '运行命令', title: described || describeCommand(raw), summary: firstLine(raw, 90), command: raw }
  }
  if (name === 'task' || name === 'delegate') {
    const prompt = input?.prompt ?? input?.description ?? input?.task
    return {
      row: '调用子智能体',
      title: '委派子任务',
      summary: typeof prompt === 'string' ? firstLine(prompt, 60) : '',
    }
  }
  const pattern = input?.pattern ?? input?.query ?? input?.glob
  if (pattern && row === '搜索') {
    return { row, title: `搜索 ${firstLine(String(pattern), 48)}`, summary: path ?? '' }
  }
  if (path) {
    const base = shortPath(path)
    const verb = row === '读取文件' ? '查看'
      : row === '创建文件' ? '创建'
        : row === '编辑文件' ? '编辑'
          : row === '查看目录' ? '查看目录'
            : row
    return { row, title: `${verb} ${base}`, summary: path }
  }
  if (name === 'goal_complete') return { row: '完成任务', title: '完成任务', summary: '' }
  return { row: block.name, title: block.name, summary: '' }
}

export interface ToolEdit {
  path: string
  /** Replaced text, for an in-place edit. */
  oldText?: string
  /** Replacement text, for an in-place edit. */
  newText?: string
  /** Whole file body, for a newly written file. */
  content?: string
}

/**
 * The diff an edit/write tool performed, when its input can be read. Only the
 * two shapes this harness writes are understood; anything else falls back to
 * the raw tool output.
 */
export function toolEdit(block: ToolBlock): ToolEdit | null {
  const input = parseInput(block.input)
  if (!input) return null
  const path = pathOf(input)
  if (!path) return null
  const name = block.name.toLowerCase()

  if (['edit_file', 'edit', 'apply_patch', 'multi_edit'].includes(name)) {
    const oldText = input.oldText ?? input.old_string ?? input.oldString
    const newText = input.newText ?? input.new_string ?? input.newString
    if (typeof oldText === 'string' && typeof newText === 'string') {
      return { path, oldText, newText }
    }
    return null
  }
  if (['write_file', 'create_file', 'write'].includes(name) && typeof input.content === 'string') {
    return { path, content: input.content }
  }
  return null
}

/** One line describing a call, e.g. `运行 grep -rn …`. */
export function describeTool(block: ToolBlock): string {
  const detail = toolDetail(block)
  return detail.summary ? `${detail.row} ${detail.summary}` : detail.row
}

/**
 * True while a call has no result yet.
 *
 * `finishedAt` is the durable signal; blocks logged before it existed fall back
 * to "no output and no error", which keeps old sessions readable.
 */
export function isRunning(block: ToolBlock) {
  if (block.finishedAt !== undefined) return false
  return !block.output && !block.isError
}
