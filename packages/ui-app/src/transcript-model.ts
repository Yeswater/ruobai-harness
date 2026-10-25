import type { ChatMessage, ReasoningBlock, ToolBlock } from '@ruobai/chat-protocol'
import { isRunning } from './tool-summary.ts'

/** One line inside a folded process group. */
export type ProcessItem =
  | { kind: 'reasoning'; key: string; block: ReasoningBlock }
  | { kind: 'tool'; key: string; block: ToolBlock }

export type PlanItem =
  | { kind: 'user'; key: string; message: ChatMessage }
  | { kind: 'text'; key: string; messageId: string; text: string; streaming: boolean }
  | { kind: 'process'; key: string; items: ProcessItem[] }
  /** A step that has started but produced nothing yet. */
  | { kind: 'pending'; key: string; messageId: string }

/**
 * Fold a transcript into renderable rows.
 *
 * Prose is always visible — folding it would hide the answer. Everything the
 * turn did on the way there (thinking, tool calls) collects into a process
 * group, which the view keeps open while it runs and collapses afterwards.
 */
export function buildPlan(messages: ChatMessage[]): PlanItem[] {
  const plan: PlanItem[] = []
  let group: ProcessItem[] = []
  let groupKey = ''

  const flush = () => {
    if (!group.length) return
    plan.push({ kind: 'process', key: groupKey, items: group })
    group = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flush()
      plan.push({ kind: 'user', key: message.id, message })
      continue
    }
    if (message.role !== 'assistant') continue
    if (message.status === 'streaming' && message.blocks.length === 0) {
      flush()
      plan.push({ kind: 'pending', key: `${message.id}-pending`, messageId: message.id })
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
      if (!group.length) {
        groupKey = message.id + (block.type === 'tool' ? `-${block.callId ?? index}` : `-${index}`)
      }
      const key = `${message.id}-${index}`
      group.push(block.type === 'reasoning'
        ? { kind: 'reasoning', key, block }
        : { kind: 'tool', key, block })
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
    const to = item.block.finishedAt
    if (from !== undefined && (start === undefined || from < start)) start = from
    if (to !== undefined && (end === undefined || to > end)) end = to
  }
  return { start, end }
}

/** Whether the group still has work in flight. */
export function isGroupRunning(items: ProcessItem[]) {
  return items.some(item => (item.kind === 'tool' ? isRunning(item.block) : item.block.finishedAt === undefined))
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

/** Label of the collapse row once a group is done. */
export function groupSummary(items: ProcessItem[]): string {
  const duration = groupDuration(items)
  const failures = items.filter(item => item.kind === 'tool' && item.block.isError).length
  const done = duration === undefined ? '已完成' : `已完成，用时 ${formatDuration(duration)}`
  return failures ? `${done}（${failures} 个失败）` : done
}
