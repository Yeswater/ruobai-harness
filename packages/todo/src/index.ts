import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/context'
import type { SessionEvent } from '@ruobai/session'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'

export const name = 'todo'
export const inject = ['tools', 'sessions']

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  id: string
  text: string
  status: TodoStatus
}

export interface TodoState {
  items: TodoItem[]
  /** Monotonic per session; clients use it to discard stale snapshots. */
  rev: number
  lastSeq: number
}

export const TODO_EVENT = 'todo/updated'
export const TODO_PROJECTION = 'todo'

const MAX_ITEMS = 40
const MAX_TEXT = 400
const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

declare module '@ruobai/cordis' {
  interface Events {
    'todo/updated'(sessionId: string, state: TodoState): void
  }
}

const EMPTY: TodoState = { items: [], rev: 0, lastSeq: -1 }

/**
 * Fold `todo/updated` into the list the model and the UI read.
 *
 * The latest event wins: the tool always writes the complete list, so replaying
 * a session needs no merge logic and a dropped frame is repaired by the next
 * snapshot.
 */
export const todoProjection = {
  init: () => EMPTY,
  apply(state: TodoState, event: SessionEvent): TodoState {
    if (event.type !== TODO_EVENT) return state
    const data = event.data as Partial<TodoState> | undefined
    return {
      items: Array.isArray(data?.items) ? data.items as TodoItem[] : [],
      rev: Number(data?.rev ?? state.rev),
      lastSeq: event.seq,
    }
  },
}

export function todoOf(ctx: Context, sessionId: string): TodoState {
  const view = ctx.sessions.view<Record<string, unknown>>(sessionId)
  return (view?.[TODO_PROJECTION] as TodoState | undefined) ?? EMPTY
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.sessions.registerProjection(TODO_PROJECTION, todoProjection), 'todo.projection')
  ctx.effect(() => ctx.tools.register(todoTool(ctx)), 'todo.tool')

  const section = {
    id: 'todo',
    // Volatile: the list changes inside a turn, so it must never be treated as
    // part of the stable prefix and must be re-read after compaction.
    order: 90,
    stability: 'turn' as const,
    maxChars: 6_000,
    render: ({ sessionId }: { sessionId: string }) => renderSection(todoOf(ctx, sessionId).items),
  }
  ctx.inject(['context'], (sectionCtx) => {
    sectionCtx.effect(() => sectionCtx.context.registerSection(section), 'todo.section')
  })
}

export default { name, inject, apply }

function todoTool(ctx: Context): ToolDefinition {
  return {
    name: 'todo_write',
    description: [
      'Record or update the task list for this session.',
      'Always pass the complete list; it replaces the previous one. Keep one item in progress at a time.',
      'Use it for multi-step work so progress survives context compaction and the user can see what remains.',
      'Open items stay on the list until you mark them completed; pass an empty list to clear it.',
    ].join(' '),
    // Session scratch state, not an external side effect: allowed in read-only mode.
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'The complete task list, in order.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id, e.g. "1". Reused when updating an item.' },
              text: { type: 'string', description: 'Short imperative description.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['tasks'],
    },
    execute(args, run) {
      const sessionId = run?.sessionId
      if (!sessionId) throw new Error('todo_write requires a session')
      const items = normalize(args?.tasks)
      const previous = todoOf(ctx, sessionId)
      const rev = previous.rev + 1
      ctx.sessions.append(sessionId, TODO_EVENT, { items, rev })
      const state: TodoState = { items, rev, lastSeq: previous.lastSeq }
      ctx.emit('todo/updated', sessionId, state)
      return summarize(items)
    },
  }
}

function normalize(input: unknown): TodoItem[] {
  if (input === undefined || input === null) throw new Error('tasks is required')
  if (!Array.isArray(input)) throw new Error('tasks must be an array')
  if (input.length > MAX_ITEMS) throw new Error(`task list is limited to ${MAX_ITEMS} items`)

  const seen = new Set<string>()
  const items = input.map((raw, index) => {
    const item = (raw ?? {}) as { id?: unknown; text?: unknown; status?: unknown }
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (!text) throw new Error(`task ${index + 1} has no text`)
    if (text.length > MAX_TEXT) throw new Error(`task ${index + 1} is longer than ${MAX_TEXT} characters`)
    if (typeof item.status !== 'string' || !STATUSES.includes(item.status as TodoStatus)) {
      throw new Error(`task ${index + 1} has an invalid status`)
    }
    const id = (typeof item.id === 'string' ? item.id.trim() : '') || String(index + 1)
    if (seen.has(id)) throw new Error(`duplicate task id "${id}"`)
    seen.add(id)
    return { id, text, status: item.status as TodoStatus }
  })
  if (items.filter(item => item.status === 'in_progress').length > 1) {
    throw new Error('only one task may be in progress')
  }
  return items
}

function summarize(items: TodoItem[]): string {
  if (!items.length) return 'Task list cleared.'
  const done = items.filter(item => item.status === 'completed').length
  const active = items.find(item => item.status === 'in_progress')
  const next = items.find(item => item.status === 'pending')
  // The full list is already in the system prompt next request; echoing it here
  // would double its cost on every update.
  return [
    `Task list updated: ${done}/${items.length} completed.`,
    active ? `In progress: ${active.text}` : '',
    next && !active ? `Next: ${next.text}` : '',
  ].filter(Boolean).join('\n')
}

function renderSection(items: TodoItem[]): string {
  if (!items.length) return ''
  return [
    '<task_list>',
    'Your current task list for this session. Update it with todo_write as work moves; keep one item in progress.',
    ...items.map(item => `${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]'} ${item.text}`),
    '</task_list>',
  ].join('\n')
}

export const meta = {
  title: '任务清单',
  description: '让模型维护会话级任务清单，跨压缩保留进度，并在界面展示。',
}
