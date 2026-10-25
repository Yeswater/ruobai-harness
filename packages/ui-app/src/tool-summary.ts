import type { ToolBlock } from '@ruobai/chat-protocol'

interface Bucket {
  verb: string
  noun: string
}

/**
 * Tools are reported by name; a run summary groups them by what the user cares
 * about ("ran 3 commands, read 5 files") instead of listing every call site.
 * Order here is the order they appear in the summary: the loudest work first,
 * the catch-all bucket last.
 */
interface NamedBucket extends Bucket {
  names: string[]
}

const BUCKETS: NamedBucket[] = [
  { verb: '运行', noun: '条命令', names: ['bash', 'run_command', 'shell', 'execute_command'] },
  { verb: '运行', noun: '个子智能体', names: ['task', 'delegate', 'subagent'] },
  { verb: '读取', noun: '个文件', names: ['read_file', 'read', 'view_file'] },
  { verb: '创建', noun: '个文件', names: ['write_file', 'create_file', 'write'] },
  { verb: '编辑', noun: '个文件', names: ['edit_file', 'apply_patch', 'edit', 'multi_edit'] },
  { verb: '查看', noun: '个目录', names: ['list_dir', 'list_files', 'list_directory'] },
  { verb: '搜索', noun: '次', names: ['search_files', 'grep', 'glob', 'search'] },
]

const OTHER: Bucket = { verb: '执行', noun: '项其他操作' }

function bucketOf(name: string) {
  const lower = name.toLowerCase()
  const found = BUCKETS.find(bucket => bucket.names.includes(lower))
  if (found) return found
  // MCP / A2A tools are `mcp__<server>__<tool>`; they belong to the catch-all
  // bucket, not to a file or shell operation.
  return OTHER
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

function pathOf(input: Record<string, unknown> | undefined) {
  const value = input?.path ?? input?.file_path ?? input?.file ?? input?.target
  return typeof value === 'string' ? value : undefined
}

export interface ToolDetail {
  /** Row title when the run is expanded. */
  title: string
  /** Shell command, shown on its own line above the output. */
  command?: string
  /** File or directory the call touched. */
  path?: string
}

/** One line describing a single call, used as the row title when expanded. */
export function describeTool(block: ToolBlock): string {
  return toolDetail(block).title
}

export function toolDetail(block: ToolBlock): ToolDetail {
  const input = parseInput(block.input)
  const path = pathOf(input)
  const name = block.name.toLowerCase()

  if (name === 'bash' || name === 'run_command' || name === 'shell') {
    const raw = input?.command ?? input?.cmd
    if (typeof raw !== 'string') return { title: '运行命令' }
    // The full command is shown in the body; the title only needs its gist.
    return { title: `运行 ${firstLine(raw, 120)}`, command: raw }
  }
  if (name === 'task' || name === 'delegate') {
    const prompt = input?.prompt ?? input?.description ?? input?.task
    return {
      title: typeof prompt === 'string' ? `子智能体 ${firstLine(prompt, 60)}` : '调用子智能体',
    }
  }
  if (path) return { title: `${bucketOf(name).verb} ${path}`, path }
  if (name === 'goal_complete') return { title: '完成任务' }
  return { title: block.name }
}

/**
 * Summary for a group of calls: "运行 3 条命令，读取 5 个文件". Failed calls are
 * called out separately so a collapsed run never hides an error.
 */
export function describeToolRun(blocks: ToolBlock[]): string {
  if (!blocks.length) return '无工具调用'
  const counts = new Map<string, { bucket: Bucket; count: number }>()
  let failures = 0

  for (const block of blocks) {
    if (block.isError) failures += 1
    const bucket = bucketOf(block.name)
    const key = `${bucket.verb}/${bucket.noun}`
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { bucket, count: 1 })
  }

  const rank = (bucket: Bucket) => {
    const index = BUCKETS.findIndex(item => item.verb === bucket.verb && item.noun === bucket.noun)
    // The catch-all bucket belongs at the end, after every named bucket.
    return index >= 0 ? index : BUCKETS.length
  }

  const summary = [...counts.values()]
    .sort((a, b) => rank(a.bucket) - rank(b.bucket))
    .map(entry => `${entry.bucket.verb} ${entry.count} ${entry.bucket.noun}`)
    .join('，')

  return failures ? `${summary}（${failures} 个失败）` : summary
}

/** True when a tool block has no result yet — used to keep runs open while live. */
export function isRunning(block: ToolBlock) {
  return !block.output && !block.isError
}
