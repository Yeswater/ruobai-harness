import type { ChatMessage, ReasoningBlock, ToolBlock } from '@ruobai/chat-protocol'
import { isRunning } from './tool-summary.ts'

/**
 * One line inside a folded process group.
 *
 * `pending` is resolved here rather than in the view: whether a row is still
 * working depends on its own timestamps *and* on the step that produced it, and
 * only this module knows both.
 */
export type ProcessItem =
  | { kind: 'reasoning'; key: string; block: ReasoningBlock; pending: boolean }
  | { kind: 'tool'; key: string; block: ToolBlock; pending: boolean }

export type PlanItem =
  | { kind: 'user'; key: string; message: ChatMessage }
  | { kind: 'text'; key: string; messageId: string; text: string; streaming: boolean }
  | {
    kind: 'process'
    key: string
    items: ProcessItem[]
    /** A step that started but has not produced anything yet. */
    placeholder?: boolean
  }

/**
 * Fold a transcript into renderable rows.
 *
 * Prose is always visible — folding it would hide the answer. Everything the
 * turn did on the way there (thinking, tool calls) collects into a process
 * group, which the view keeps open while it runs and collapses afterwards.
 *
 * A step that has produced nothing yet joins the *current* group instead of
 * starting its own row: a separate "思考中…" row next to a finished group made
 * the transcript flicker between two states on every tool round trip.
 */
export function buildPlan(messages: ChatMessage[]): PlanItem[] {
  const plan: PlanItem[] = []
  let group: ProcessItem[] = []
  /** Key of the open group; set once so a placeholder can grow into a full group. */
  let groupKey = ''
  let waiting = false

  const open = (key: string) => {
    if (!groupKey) groupKey = key
  }

  const flush = () => {
    if (!group.length && !waiting) return
    // A group with no rows yet is a placeholder: the step started but has not
    // produced anything. It renders as one waiting row inside the same group,
    // so the transcript does not flash a second row on every tool round trip.
    plan.push({
      kind: 'process',
      key: groupKey,
      items: group,
      ...(group.length ? {} : { placeholder: true }),
    })
    group = []
    groupKey = ''
    waiting = false
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flush()
      plan.push({ kind: 'user', key: message.id, message })
      continue
    }
    if (message.role !== 'assistant') continue
    if (message.blocks.length === 0) {
      if (message.status === 'streaming') {
        open(`${message.id}-pending`)
        waiting = true
      }
      continue
    }

    message.blocks.forEach((block, index) => {
      if (block.type === 'text') {
        flush()
        plan.push({
          kind: 'text',
          key: `${message.id}-${index}`,
          messageId: message.id,
          text: block.text,
          // The caret belongs to the step that is still arriving.
          streaming: message.status === 'streaming' && index === message.blocks.length - 1,
        })
        return
      }
      if (block.type !== 'reasoning' && block.type !== 'tool') return
      open(message.id + (block.type === 'tool' ? `-${block.callId ?? index}` : `-${index}`))
      const key = `${message.id}-${index}`
      // A settled step is finished even when the log has no timestamps for it
      // (sessions written before timing was recorded). Reading `finishedAt`
      // alone left every old thought row stuck on "思考中".
      const settled = message.status !== 'streaming'
      const pending = settled
        ? false
        : block.type === 'reasoning' ? block.finishedAt === undefined : isRunning(block)
      group.push(block.type === 'reasoning'
        ? { kind: 'reasoning', key, block, pending }
        : { kind: 'tool', key, block, pending })
    })
  }
  flush()
  return plan
}

/** A tool row and a thought row both carry a start and an end. */
function bounds(items: ProcessItem[]) {
  let start: number | undefined
  let end: number | undefined
  for (const item of items) {
    const from = item.block.startedAt
    // An interrupted action may never get a finish stamp; its start still
    // bounds the group instead of leaving the whole row without a duration.
    const to = item.block.finishedAt ?? from
    if (from !== undefined && (start === undefined || from < start)) start = from
    if (to !== undefined && (end === undefined || to > end)) end = to
  }
  return { start, end }
}

/** Whether the group still has work in flight. */
export function isGroupRunning(items: ProcessItem[]) {
  return items.some(item => item.pending)
}

/** Elapsed time of one row, or undefined when it has no recorded span. */
export function itemDuration(item: ProcessItem): number | undefined {
  const { startedAt, finishedAt } = item.block
  if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) return undefined
  return finishedAt - startedAt
}

/** Elapsed wall time of a finished group, or undefined while it has no span. */
export function groupDuration(items: ProcessItem[]): number | undefined {
  const { start, end } = bounds(items)
  if (start === undefined || end === undefined || end < start) return undefined
  return end - start
}

/** Compact duration: `42 秒`, `1分30秒`, `1小时2分`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60 ? `${seconds % 60}秒` : ''}`
  const hours = Math.floor(minutes / 60)
  return `${hours}小时${minutes % 60 ? `${minutes % 60}分` : ''}`
}

/**
 * Label of the collapse row once a group is done.
 *
 * A span under a second carries no information ("用时 0 秒"), so it is folded
 * into the plain label instead of being printed.
 */
export function groupSummary(items: ProcessItem[]): string {
  const duration = groupDuration(items)
  const failures = items.filter(item => item.kind === 'tool' && item.block.isError).length
  const done = duration === undefined || duration < 500
    ? '已完成'
    : `已完成，用时 ${formatDuration(duration)}`
  return failures ? `${done}（${failures} 个失败）` : done
}
