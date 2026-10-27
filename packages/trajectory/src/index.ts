import type { Context } from '@ruobai/cordis'
import type { ProjectionDefinition, SessionEvent } from '@ruobai/session'
import type {
  ProjectionMeta, RecordTiming, TimingSpan, TrajectoryRecord, TurnSummary, TurnTokens, UsageEntry,
} from './types.ts'

export type * from './types.ts'

const MAX_DETAIL = 4_000
const MAX_PREVIEW = 140

const SKIP = new Set(['session/title', 'session/meta', 'file/change', 'file/revert'])

function emptyMeta(): ProjectionMeta {
  return { sessionId: '', rev: 0, lastSeq: -1, updatedAt: 0 }
}

function bump(meta: ProjectionMeta, event: SessionEvent): ProjectionMeta {
  return {
    sessionId: meta.sessionId,
    rev: meta.rev + 1,
    lastSeq: Math.max(meta.lastSeq, event.seq),
    updatedAt: event.ts,
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function clip(value: unknown, limit = MAX_DETAIL): string {
  const source = text(value)
  return source.length <= limit ? source : `${source.slice(0, limit)}…`
}

function compact(value: unknown, limit = MAX_PREVIEW): string {
  return text(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

function opensTurn(event: SessionEvent): boolean {
  return event.type === 'message/user' && event.data?.source?.kind !== 'skill'
}

function toolCalls(event: SessionEvent): Array<{ id?: string; name?: string; arguments?: string }> {
  if (event.type !== 'message/assistant') return []
  return (event.data?.parts ?? []).filter((part: any) => part.type === 'tool-call')
}

function toolCallCount(event: SessionEvent): number {
  return toolCalls(event).length
}

function isCounted(event: SessionEvent): boolean {
  if (SKIP.has(event.type)) return false
  return event.type === 'message/user'
    || event.type === 'message/assistant'
    || event.type === 'context/snapshot'
    || event.type === 'context/summary'
    || event.type === 'context/memory'
    || event.type === 'turn/error'
    || event.type === 'turn/notice'
    || event.type === 'memory/injected'
    || event.type === 'memory/commit'
    || event.type === 'memory/distill'
    || event.type === 'wiki/injected'
    || event.type === 'wiki/updated'
    || event.type === 'wiki/indexed'
}

function countRecords(event: SessionEvent): number {
  if (!isCounted(event)) return 0
  if (event.type === 'message/assistant') return 1 + toolCallCount(event)
  return 1
}

function addTokens(target: TurnTokens, usage: any) {
  target.input += Number(usage?.inputTokens ?? 0)
  target.output += Number(usage?.outputTokens ?? 0)
  target.cacheRead += Number(usage?.cachedInputTokens ?? 0)
}

/* ------------------------------------------------------------------ turns */

export interface TurnsState {
  meta: ProjectionMeta
  turns: TurnSummary[]
}

function newTurn(index: number, event: SessionEvent): TurnSummary {
  const title = opensTurn(event)
    ? compact(event.data?.text, 80)
    : '会话开始前'
  return {
    index,
    title,
    startedAt: event.ts,
    status: index === 0 ? 'done' : 'running',
    recordCount: 0,
    toolCount: 0,
    stepCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0 },
    firstSeq: event.seq,
    lastSeq: event.seq,
  }
}

export const turnsProjection: ProjectionDefinition<TurnsState> = {
  init: () => ({ meta: emptyMeta(), turns: [] }),
  apply(state, event) {
    if (SKIP.has(event.type)) return state
    const meta = bump(state.meta, event)
    const turns = state.turns.slice()

    if (opensTurn(event)) {
      const previous = turns.at(-1)
      if (previous && previous.status === 'running') {
        // Keep the last event's time: the next user message can be minutes
        // later, and that idle gap is not part of the turn's duration.
        turns[turns.length - 1] = { ...previous, status: 'done' }
      }
      const next = newTurn(turns.length + 1, event)
      next.recordCount = 1
      turns.push(next)
      return { meta, turns }
    }

    if (!turns.length) {
      const start = newTurn(0, event)
      start.recordCount = countRecords(event)
      turns.push(start)
      return { meta, turns }
    }

    const last = { ...turns[turns.length - 1]! }
    last.endedAt = event.ts
    last.lastSeq = Math.max(last.lastSeq, event.seq)
    last.recordCount += countRecords(event)
    last.toolCount += toolCallCount(event)
    if (event.type === 'message/assistant') {
      last.stepCount += 1
      addTokens(last.tokens, event.data?.usage)
    }
    if (event.type === 'turn/error') last.status = 'error'
    if (event.type === 'turn/notice' && event.data?.kind === 'max-steps') last.status = 'stopped'
    turns[turns.length - 1] = last
    return { meta, turns }
  },
}

/* ---------------------------------------------------------------- records */

export interface RecordsState {
  meta: ProjectionMeta
  records: TrajectoryRecord[]
  turn: number
  step: number
}

function recordId(kind: string, event: SessionEvent, suffix?: string) {
  return `${kind}:${suffix ?? event.seq}`
}

function assistantRecord(event: SessionEvent, turn: number, step: number): TrajectoryRecord {
  const parts: any[] = event.data?.parts ?? []
  const prose = parts.filter(part => part.type === 'text').map(part => text(part.text)).join('\n\n').trim()
  const reasoning = parts.filter(part => part.type === 'reasoning').map(part => text(part.text)).join('\n\n').trim()
  const calls = toolCalls(event)
  const preview = compact(prose)
    || (calls.length ? `工具 ${calls.map(call => call.name).filter(Boolean).join('、')}` : '（仅工具调用）')
  const detail = [
    reasoning ? `[思考]\n${reasoning}` : '',
    prose,
  ].filter(Boolean).join('\n\n')
  const timing = event.data?.timing
  return {
    id: recordId('assistant', event),
    seq: event.seq,
    turn,
    step,
    kind: 'assistant',
    time: event.ts,
    preview,
    ...(detail ? { detail: clip(detail) } : {}),
    ...(timing
      ? {
        timing: {
          ...(timing.stepStartTime !== undefined ? { startedAt: timing.stepStartTime } : {}),
          ...(timing.firstTokenTime !== undefined ? { firstTokenAt: timing.firstTokenTime } : {}),
          ...(timing.completedTime !== undefined ? { completedAt: timing.completedTime } : {}),
        },
      }
      : {}),
    ...(event.data?.usage
      ? {
        usage: {
          input: Number(event.data.usage.inputTokens ?? 0),
          output: Number(event.data.usage.outputTokens ?? 0),
          cacheRead: Number(event.data.usage.cachedInputTokens ?? 0),
        },
      }
      : {}),
  }
}

function contextRecord(event: SessionEvent, turn: number, step: number): TrajectoryRecord | undefined {
  const data = event.data ?? {}
  if (event.type === 'context/snapshot') {
    const preview = [
      data.mode ? `模式 ${data.mode}` : '',
      `${Number(data.messages ?? 0)} 条消息`,
      `≈${Number(data.estimatedTokens ?? 0).toLocaleString()} tokens`,
    ].filter(Boolean).join(' · ')
    const detail = [
      [data.provider, data.model].filter(Boolean).join('/'),
      data.workspace ? `工作区 ${data.workspace}` : '',
      `${Number(data.messages ?? 0)} 条消息 · ${Number(data.tools ?? 0)} 个工具 · 系统提示 ${Number(data.systemChars ?? 0).toLocaleString()} 字符`,
      `摘要覆盖至 #${data.summaryUpToSeq ?? '—'} · 记忆覆盖至 #${data.memoryUpToSeq ?? '—'}`,
      data.focus ? `本轮输入：${data.focus}` : '',
    ].filter(Boolean).join('\n')
    return { id: recordId('context', event), seq: event.seq, turn, step, kind: 'context', time: event.ts, preview, detail }
  }
  if (event.type === 'context/summary') {
    return {
      id: recordId('compacted', event),
      seq: event.seq, turn, step, kind: 'compacted', time: event.ts,
      preview: `压缩 ${Number(data.before ?? 0).toLocaleString()} → ${Number(data.after ?? 0).toLocaleString()} tokens`,
      detail: clip(data.text),
    }
  }
  if (event.type === 'context/memory') {
    return {
      id: recordId('context', event),
      seq: event.seq, turn, step, kind: 'context', time: event.ts,
      preview: `记忆覆盖至 #${data.upToSeq ?? '?'}`,
      detail: clip(data.text),
    }
  }
  if (event.type === 'turn/error') {
    return { id: recordId('context', event), seq: event.seq, turn, step, kind: 'context', time: event.ts, preview: compact(data.message) || '回合错误', detail: clip(data.message) }
  }
  if (event.type.startsWith('memory/')) {
    return memoryRecord(event, turn, step)
  }
  if (event.type.startsWith('wiki/')) {
    return wikiRecord(event, turn, step)
  }
  if (event.type === 'turn/notice') {
    return { id: recordId('context', event), seq: event.seq, turn, step, kind: 'compacted', time: event.ts, preview: compact(data.message ?? data.kind) || '提示' }
  }
  return undefined
}

function memoryRecord(event: SessionEvent, turn: number, step: number): TrajectoryRecord {
  const data = event.data ?? {}
  const base = {
    id: recordId('memory', event),
    seq: event.seq,
    turn,
    step,
    kind: 'memory' as const,
    time: event.ts,
  }
  if (event.type === 'memory/injected') {
    const count = Array.isArray(data.ids) ? data.ids.length : 0
    return { ...base, preview: `注入 ${count} 条 · ${Number(data.bytes ?? 0)} 字符`, detail: clip(data.text) }
  }
  if (event.type === 'memory/added') {
    return { ...base, preview: `新增 ${data.id ?? ''} · ${compact(data.item?.text)}`, detail: clip(data.item?.text) }
  }
  if (event.type === 'memory/updated') return { ...base, preview: `更新 ${data.id ?? ''}` }
  if (event.type === 'memory/forgot') return { ...base, preview: `遗忘 ${data.id ?? ''}` }
  if (event.type === 'memory/commit') {
    return {
      ...base,
      preview: `提交 ${data.status ?? ''} · +${Number(data.added ?? 0)} ~${Number(data.updated ?? 0)} −${Number(data.skipped ?? 0)}`,
      ...(data.error ? { detail: clip(data.error) } : {}),
    }
  }
  if (event.type === 'memory/distill') {
    return {
      ...base,
      preview: `蒸馏 ${data.provider ?? ''}/${data.model ?? ''} · ${Number(data.inputTokens ?? 0)} → ${Number(data.outputTokens ?? 0)} tokens`,
    }
  }
  return { ...base, preview: event.type }
}

function wikiRecord(event: SessionEvent, turn: number, step: number): TrajectoryRecord {
  const data = event.data ?? {}
  const base = {
    id: recordId('wiki', event),
    seq: event.seq,
    turn,
    step,
    kind: 'wiki' as const,
    time: event.ts,
  }
  if (event.type === 'wiki/injected') {
    return { ...base, preview: `目录 ${Number(data.pages ?? 0)} 页 · ${Number(data.bytes ?? 0)} 字符`, detail: clip(data.text) }
  }
  if (event.type === 'wiki/updated') {
    return { ...base, preview: `页面 ${data.page ?? ''} · r${Number(data.revision ?? 0)}${data.created ? ' · 新建' : ''}` }
  }
  if (event.type === 'wiki/indexed') {
    return {
      ...base,
      preview: `索引 ${Number(data.pages ?? 0)} 页 / ${Number(data.chunks ?? 0)} 块${data.rebuilt ? ` · 重建 ${Number(data.rebuilt)}` : ''}`,
    }
  }
  return { ...base, preview: event.type }
}

export const recordsProjection: ProjectionDefinition<RecordsState> = {
  init: () => ({ meta: emptyMeta(), records: [], turn: 0, step: 0 }),
  apply(state, event) {
    if (SKIP.has(event.type)) return state
    const meta = bump(state.meta, event)
    const records = state.records.slice()
    let turn = state.turn
    let step = state.step

    if (opensTurn(event)) {
      turn += 1
      step = 0
      const record: TrajectoryRecord = {
        id: recordId('user', event),
        seq: event.seq, turn, step, kind: 'user', time: event.ts,
        preview: compact(event.data?.text),
        detail: clip(event.data?.text),
      }
      records.push(record)
      return { meta, records, turn, step }
    }

    if (event.type === 'message/user') {
      records.push({
        id: recordId('context', event),
        seq: event.seq, turn, step, kind: 'context', time: event.ts,
        preview: compact(event.data?.text),
        detail: clip(event.data?.text),
        source: event.data?.source,
      })
      return { meta, records, turn, step }
    }

    if (event.type === 'message/assistant') {
      step += 1
      records.push(assistantRecord(event, turn, step))
      for (const call of toolCalls(event)) {
        records.push({
          id: recordId('tool', event, call.id),
          seq: event.seq, turn, step, kind: 'tool', time: event.ts,
          preview: `${call.name ?? 'tool'} · ${compact(call.arguments, 90)}`,
          detail: clip(call.arguments),
          callId: call.id,
          toolName: call.name,
          timing: { startedAt: event.ts },
        })
      }
      return { meta, records, turn, step }
    }

    if (event.type === 'tool/result') {
      const index = records.findIndex(record => record.callId && record.callId === event.data?.callId)
      const content = text(event.data?.content)
      if (index >= 0) {
        const existing = records[index]!
        records[index] = {
          ...existing,
          preview: `${event.data?.name ?? existing.toolName ?? 'tool'} · ${content.length} 字符${event.data?.isError ? ' · 失败' : ''}`,
          detail: `参数\n${existing.detail ?? ''}\n\n结果\n${clip(content)}`,
          isError: Boolean(event.data?.isError),
          timing: { ...existing.timing, completedAt: event.ts },
        }
      } else {
        records.push({
          id: recordId('tool', event, event.data?.callId),
          seq: event.seq, turn, step, kind: 'tool', time: event.ts,
          preview: `${event.data?.name ?? 'tool'} · ${content.length} 字符${event.data?.isError ? ' · 失败' : ''}`,
          detail: clip(content),
          callId: event.data?.callId,
          toolName: event.data?.name,
          isError: Boolean(event.data?.isError),
          timing: { completedAt: event.ts },
        })
      }
      return { meta, records, turn, step }
    }

    const extra = contextRecord(event, turn, step)
    if (extra) records.push(extra)
    return { meta, records, turn, step }
  },
}

/* ----------------------------------------------------------------- timing */

export interface TimingState {
  meta: ProjectionMeta
  spans: TimingSpan[]
}

export const timingProjection: ProjectionDefinition<TimingState> = {
  init: () => ({ meta: emptyMeta(), spans: [] }),
  apply(state, event) {
    if (SKIP.has(event.type)) return state
    const meta = bump(state.meta, event)
    if (event.type === 'message/assistant') {
      const timing = event.data?.timing
      if (!timing) return { meta, spans: state.spans }
      const span: TimingSpan = {
        recordId: recordId('assistant', event),
        kind: 'assistant',
        ...(timing.stepStartTime !== undefined ? { startedAt: timing.stepStartTime } : {}),
        ...(timing.firstTokenTime !== undefined ? { firstTokenAt: timing.firstTokenTime } : {}),
        ...(timing.completedTime !== undefined ? { completedAt: timing.completedTime } : {}),
      }
      const spans = state.spans.filter(item => item.recordId !== span.recordId)
      spans.push(span)
      return { meta, spans }
    }
    if (event.type === 'tool/result') {
      const id = recordId('tool', event, event.data?.callId)
      const index = state.spans.findIndex(item => item.recordId === id)
      if (index < 0) return { meta, spans: state.spans }
      const spans = state.spans.slice()
      spans[index] = { ...spans[index]!, completedAt: event.ts }
      return { meta, spans }
    }
    return { meta, spans: state.spans }
  },
}

/* ------------------------------------------------------------------ usage */

export interface UsageState {
  meta: ProjectionMeta
  entries: UsageEntry[]
  turn: number
  step: number
}

export const usageProjection: ProjectionDefinition<UsageState> = {
  init: () => ({ meta: emptyMeta(), entries: [], turn: 0, step: 0 }),
  apply(state, event) {
    if (SKIP.has(event.type)) return state
    const meta = bump(state.meta, event)
    let turn = state.turn
    let step = state.step
    if (opensTurn(event)) return { meta, entries: state.entries, turn: turn + 1, step: 0 }
    if (event.type !== 'message/assistant') return { meta, entries: state.entries, turn, step }
    step += 1
    const usage = event.data?.usage
    if (!usage) return { meta, entries: state.entries, turn, step }
    const entry: UsageEntry = {
      turn,
      step,
      input: Number(usage.inputTokens ?? 0),
      output: Number(usage.outputTokens ?? 0),
      cacheRead: Number(usage.cachedInputTokens ?? 0),
    }
    return { meta, entries: [...state.entries, entry], turn, step }
  },
}

/* ----------------------------------------------------------------- plugin */

export interface Config {
  /** Projection keys are namespaced so another plugin can add units later. */
  namespace?: string
}

export default {
  name: 'trajectory',
  inject: ['sessions'],
  apply(ctx: Context, config: Config = {}) {
    const ns = config.namespace ?? 'trajectory'
    ctx.effect(() => ctx.sessions.registerProjection(`${ns}.turns`, turnsProjection), `${ns}.turns`)
    ctx.effect(() => ctx.sessions.registerProjection(`${ns}.records`, recordsProjection), `${ns}.records`)
    ctx.effect(() => ctx.sessions.registerProjection(`${ns}.timing`, timingProjection), `${ns}.timing`)
    ctx.effect(() => ctx.sessions.registerProjection(`${ns}.usage`, usageProjection), `${ns}.usage`)
  },
}

export const meta = {
  title: '轨迹投影',
  description: '把会话事件折叠成轮次、记录、耗时与 token 用量快照。',
}
