import type { ChatBlock, ChatMessage, ToolBlock } from '@ruobai/chat-protocol'

export type PlanItem =
  | { kind: 'message'; key: string; message: ChatMessage; index: number }
  | { kind: 'run'; key: string; blocks: ToolBlock[] }

export type Segment =
  | { kind: 'block'; key: string; block: ChatBlock; index: number }
  | { kind: 'run'; key: string; blocks: ToolBlock[] }

function toolOnly(message: ChatMessage) {
  return message.role === 'assistant'
    && message.blocks.length > 0
    && message.blocks.every(block => block.type === 'tool')
}

/**
 * Consecutive tool-only steps belong to the same visible action burst, so they
 * fold into one summary row instead of a column of cards. Any message carrying
 * prose, reasoning or a new user turn breaks the burst.
 */
export function buildPlan(messages: ChatMessage[]): PlanItem[] {
  const plan: PlanItem[] = []
  messages.forEach((message, index) => {
    if (!toolOnly(message)) {
      plan.push({ kind: 'message', key: message.id, message, index })
      return
    }
    const blocks = message.blocks as ToolBlock[]
    const previous = plan.at(-1)
    if (previous?.kind === 'run') previous.blocks.push(...blocks)
    else plan.push({ kind: 'run', key: message.id, blocks: [...blocks] })
  })
  return plan
}

/**
 * Splits one message into cards and tool runs: a step that both writes prose and
 * calls tools keeps the prose inline and folds the calls.
 */
export function segmentsOf(message: ChatMessage): Segment[] {
  const segments: Segment[] = []
  let run: ToolBlock[] = []
  let runKey = ''
  const flush = () => {
    if (!run.length) return
    segments.push({ kind: 'run', key: runKey, blocks: run })
    run = []
  }

  message.blocks.forEach((block, index) => {
    if (block.type === 'tool') {
      if (!run.length) runKey = block.callId ?? `${message.id}-${index}`
      run.push(block)
      return
    }
    flush()
    segments.push({ kind: 'block', key: `${message.id}-${index}`, block, index })
  })
  flush()
  return segments
}
