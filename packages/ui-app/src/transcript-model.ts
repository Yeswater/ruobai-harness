import type { ChatMessage, ReasoningBlock, ToolBlock } from '@ruobai/chat-protocol'
import { awaitingAnswer, isRunning } from './tool-summary.ts'

/**
 * One line inside a folded process group.
 *
 * `pending` is resolved here rather than in the view: whether a row is still
 * working depends on its own timestamps *and* on the step that produced it, and
 * only this module knows both.
 */
export type StepItem =
  | { kind: 'reasoning'; key: string; block: ReasoningBlock; pending: boolean }
  | { kind: 'tool'; key: string; block: ToolBlock; pending: boolean }
  /** Prose folded into a finished turn's single summary row. */
  | { kind: 'text'; key: string; text: string }

export type ProcessItem =
  | StepItem
  /** One prose-led section inside a finished turn: the steps that followed it. */
  | { kind: 'segment'; key: string; text?: string; items: StepItem[] }

export type PlanItem =
  | { kind: 'user'; key: string; message: ChatMessage }
  | { kind: 'text'; key: string; messageId: string; text: string; streaming: boolean }
  /**
   * A question waiting for the human.
   *
   * It is not a process row: the user has to act on it, and folding it into the
   * open "执行中…" group buried it among the steps that came before. It becomes
   * a normal step again once the answer is logged.
   */
  | { kind: 'ask'; key: string; block: ToolBlock }
  /** A step that was cut off before it finished producing an answer. */
  | { kind: 'interrupted'; key: string }
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
export function buildPlan(messages: ChatMessage[], turnStreaming = false): PlanItem[] {
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

  for (const [position, message] of messages.entries()) {
    if (message.role === 'user') {
      flush()
      plan.push({ kind: 'user', key: message.id, message })
      continue
    }
    if (message.role !== 'assistant') continue
    // A question can only be waiting if nothing came after the step that asked.
    const isLast = position === messages.length - 1
    if (message.blocks.length === 0) {
      if (message.status === 'streaming') {
        open(`${message.id}-pending`)
        waiting = true
      } else if (message.status === 'interrupted') {
        flush()
        plan.push({ kind: 'interrupted', key: `${message.id}-interrupted` })
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
      const key = `${message.id}-${index}`
      const settled = message.status !== 'streaming'
      // A question the human has not answered yet stands on its own, between
      // the steps that led to it and whatever follows the answer. Only the last
      // step can still be waiting: an unanswered call further back belongs to
      // an interrupted turn and stays in its history group.
      if (block.type === 'tool' && awaitingAnswer(block) && isLast) {
        flush()
        plan.push({ kind: 'ask', key, block })
        return
      }
      open(message.id + (block.type === 'tool' ? `-${block.callId ?? index}` : `-${index}`))
      const pending = block.type === 'tool'
        ? (!settled && isRunning(block))
        : settled ? false : block.finishedAt === undefined
      group.push(block.type === 'reasoning'
        ? { kind: 'reasoning', key, block, pending }
        : { kind: 'tool', key, block, pending })
    })

    if (message.status === 'interrupted') {
      flush()
      plan.push({ kind: 'interrupted', key: `${message.id}-interrupted` })
    }
  }
  flush()
  return mergeFinishedTurns(plan, turnStreaming)
}

/**
 * One finished turn shows one process group.
 *
 * While a turn runs, its groups stay split by prose so progress remains
 * visible. Once it settles, every thought and call from that turn folds into
 * a single summary row (`已完成，用时 …`), placed where the turn's first
 * process group started. Earlier turns merge even while a later turn is live.
 */
function mergeFinishedTurns(plan: PlanItem[], streaming: boolean): PlanItem[] {
  const merged: PlanItem[] = []
  let index = 0
  while (index < plan.length) {
    const head = plan[index]!
    if (head.kind === 'user') {
      merged.push(head)
      index += 1
      continue
    }
    const segment: PlanItem[] = []
    while (index < plan.length && plan[index]!.kind !== 'user') {
      segment.push(plan[index]!)
      index += 1
    }
    const live = streaming && index >= plan.length
    const groups = segment.filter(item => item.kind === 'process')
    // A plain answer with no tools keeps its prose visible: there is no run to
    // summarize, and hiding it would turn every reply into a click. An
    // interrupted turn keeps its rows open too — folding it into "已完成"
    // would present a fragment as a finished turn.
    if (live || !groups.length || segment.some(item => item.kind === 'interrupted')) {
      merged.push(...segment)
      continue
    }
    // The turn's final paragraph is the answer: it stays outside the group so
    // the transcript still reads like a message. Everything before it folds.
    const last = segment.at(-1)
    const finalText = last?.kind === 'text' ? last : undefined
    // Fold once more by prose: each paragraph and the steps it introduced form
    // one collapsible section. Steps before the first paragraph get a lead
    // section so nothing is lost.
    const items: ProcessItem[] = []
    let current: Extract<ProcessItem, { kind: 'segment' }> | undefined
    let seq = 0
    const segmentFor = (text?: string) => {
      current = {
        kind: 'segment',
        key: text !== undefined ? `segment:${seq}` : `segment:lead`,
        ...(text !== undefined ? { text } : {}),
        items: [],
      }
      seq += 1
      items.push(current)
      return current
    }
    for (const item of segment) {
      if (item === finalText) continue
      const steps: StepItem[] = item.kind === 'process'
        ? item.items.filter((step): step is StepItem => step.kind !== 'segment')
        : item.kind === 'text'
          ? [item]
          : item.kind === 'ask'
            // A waiting question in a finished turn is no longer live (the page
            // was reloaded after the host lost it); it reads as a normal step.
            ? [{ kind: 'tool', key: item.key, block: item.block, pending: false }]
            : []
      for (const step of steps) {
        if (step.kind === 'text') {
          segmentFor(step.text)
          continue
        }
        ;(current ?? segmentFor()).items.push(step)
      }
    }
    const placeholder = groups.some(item => item.kind === 'process' && item.placeholder)
    merged.push({
      kind: 'process',
      key: segment.find(item => item.kind === 'process')!.key,
      items,
      ...(items.length ? {} : { placeholder }),
    })
    if (finalText) merged.push(finalText)
  }
  return merged
}

/** Segments nest steps; duration and counts always apply to the leaves. */
export function processSteps(items: ProcessItem[]): StepItem[] {
  const out: StepItem[] = []
  for (const item of items) {
    if (item.kind === 'segment') out.push(...item.items)
    else out.push(item)
  }
  return out
}

/** A tool row and a thought row both carry a start and an end. */
function bounds(items: ProcessItem[]) {
  let start: number | undefined
  let end: number | undefined
  for (const item of processSteps(items)) {
    if (item.kind === 'text') continue
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
  return processSteps(items).some(item => item.kind !== 'text' && item.pending)
}

/**
 * Whether a process group renders open.
 *
 * The turn's streaming flag is the authority: a group left behind by a finished
 * turn is never running. The newest group stays open for the whole streaming
 * turn, because between two model steps none of its rows is pending at that
 * exact moment but more work is still coming.
 */
export function shouldGroupRun(options: {
  streaming: boolean
  active: boolean
  placeholder?: boolean
  running: boolean
}) {
  return options.streaming
    && (options.active || Boolean(options.placeholder) || options.running)
}

/** Elapsed time of one row, or undefined when it has no recorded span. */
export function itemDuration(item: ProcessItem): number | undefined {
  if (item.kind === 'text' || item.kind === 'segment') return undefined
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
  const leaves = processSteps(items)
  const failures = leaves.filter(item => item.kind === 'tool' && item.block.isError).length
  const tools = leaves.filter((item): item is Extract<ProcessItem, { kind: 'tool' }> => item.kind === 'tool')
  const commands = tools.filter(item => COMMAND_TOOLS.has(item.block.name.toLowerCase())).length
  const others = tools.length - commands
  const counts = [
    commands ? `${commands} 条命令` : '',
    others ? `${others} 个工具` : '',
  ].filter(Boolean).join(' · ')
  const done = duration === undefined || duration < 500
    ? '已完成'
    : `已完成，用时 ${formatDuration(duration)}`
  return [counts, done].filter(Boolean).join(' · ') + (failures ? `（${failures} 个失败）` : '')
}

/** Tools whose row is a shell command rather than an action on a path. */
const COMMAND_TOOLS = new Set(['bash', 'run_command', 'shell', 'execute_command'])
