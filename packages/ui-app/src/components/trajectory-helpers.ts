import type { TrajectoryEvent } from '../api.ts'
import { formatTokens } from './ContextCard.tsx'

export type TrajectoryLane = 0 | 1 | 2

export const TRAJECTORY_LANES: Array<{ id: TrajectoryLane; label: string }> = [
  { id: 0, label: '输入' },
  { id: 1, label: '模型' },
  { id: 2, label: '工具' },
]

export function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function eventLane(event: TrajectoryEvent): TrajectoryLane {
  if (event.type === 'tool/result') return 2
  if (event.type === 'message/assistant') return 1
  return 0
}

export function eventKind(event: TrajectoryEvent) {
  if (event.type === 'message/user') {
    // A skill body is injected context, not something the user typed.
    return event.data?.source?.kind === 'skill' ? 'context' : 'user'
  }
  if (event.type === 'message/assistant') return 'assistant'
  if (event.type === 'tool/result') return 'tool'
  if (event.type === 'turn/error') return 'error'
  if (event.type === 'context/snapshot' || event.type === 'context/summary'
    || event.type === 'context/memory') return 'context'
  return 'notice'
}

/**
 * Whether this event opens a user turn.
 *
 * Skill injections land right after the user's message and belong to the same
 * turn; counting them separately split one turn into a phantom one.
 */
export function opensTurn(event: TrajectoryEvent) {
  return event.type === 'message/user' && event.data?.source?.kind !== 'skill'
}

/** Model-facing context injected as a user-role message (e.g. a skill body). */
export function isInjectedContext(event: TrajectoryEvent) {
  return event.type === 'message/user' && event.data?.source?.kind === 'skill'
}

export function isContextEvent(event: TrajectoryEvent) {
  return event.type === 'context/snapshot'
    || event.type === 'context/summary'
    || event.type === 'context/memory'
    || isInjectedContext(event)
}

export function eventLabel(event: TrajectoryEvent) {
  switch (event.type) {
    case 'message/user': return event.data?.source?.kind === 'skill' ? '技能' : '用户'
    case 'message/assistant': return '助手'
    case 'tool/result': return '工具'
    case 'context/snapshot': return '上下文'
    case 'context/summary': return '压缩'
    case 'context/memory': return '记忆'
    case 'turn/error': return '错误'
    case 'turn/notice': return '提示'
    default: return event.type
  }
}

export function eventPreview(event: TrajectoryEvent) {
  const data = event.data
  if (event.type === 'message/user') {
    const text = (data?.text ?? '').replace(/\s+/g, ' ').slice(0, 140)
    return data?.source?.kind === 'skill'
      ? [`技能 ${data.source.name ?? ''}`.trim(), text].filter(Boolean).join(' · ')
      : text
  }
  if (event.type === 'message/assistant') {
    const parts = data?.parts ?? []
    const text = parts.find(part => part.type === 'text')?.text ?? ''
    const calls = [...new Set(parts
      .filter(part => part.type === 'tool-call')
      .map(part => part.name)
      .filter((name): name is string => Boolean(name)))]
    return [
      text.replace(/\s+/g, ' ').slice(0, 120),
      calls.length ? `工具 ${calls.join('、')}` : '',
    ].filter(Boolean).join(' · ')
  }
  if (event.type === 'tool/result') {
    return `${data?.name ?? 'tool'} · ${data?.chars ?? 0} 字符${data?.isError ? ' · 失败' : ''}`
  }
  if (event.type === 'context/snapshot') {
    const where = String(data?.workspace ?? '').split('/').filter(Boolean).pop()
    return [
      data?.mode ? `模式 ${data.mode}` : '',
      `${Number(data?.messages ?? 0)} 条消息`,
      formatTokens(Number(data?.estimatedTokens ?? 0)),
      where ?? '',
    ].filter(Boolean).join(' · ')
  }
  if (event.type === 'context/summary') {
    return `${triggerLabel(data?.trigger)} · ${formatTokens(Number(data?.before ?? 0))} → ${formatTokens(Number(data?.after ?? 0))}`
  }
  if (event.type === 'context/memory') return `覆盖至 #${data?.upToSeq ?? '?'}`
  if (event.type === 'turn/error') return String(data?.message ?? '')
  if (event.type === 'turn/notice') return String(data?.message ?? data?.kind ?? '')
  return ''
}

export function eventText(event: TrajectoryEvent) {
  const data = event.data
  if (event.type === 'message/user') return data?.text ?? ''
  if (event.type === 'message/assistant') {
    return (data?.parts ?? []).map((part) => {
      if (part.type === 'text') return part.text ?? ''
      if (part.type === 'reasoning') return `[思考]\n${part.text ?? ''}`
      if (part.type === 'tool-call') return `[工具] ${part.name ?? ''}\n${part.arguments ?? ''}`
      return ''
    }).filter(Boolean).join('\n\n')
  }
  if (event.type === 'tool/result') return data?.content ?? ''
  if (event.type === 'context/snapshot') {
    const target = [data?.provider, data?.model].filter(Boolean).join('/')
    return [
      [target ? `模型 ${target}` : '', data?.mode ? `模式 ${data.mode}` : '',
        data?.permission ? `权限 ${data.permission}` : ''].filter(Boolean).join(' · '),
      data?.workspace ? `工作区 ${data.workspace}` : '',
      `${Number(data?.messages ?? 0)} 条消息 · ${Number(data?.tools ?? 0)} 个工具 · 系统提示 ${Number(data?.systemChars ?? 0).toLocaleString()} 字符`,
      `估算 ${formatTokens(Number(data?.estimatedTokens ?? 0))} tokens · 第 ${Number(data?.turns ?? 0)} 轮`,
      data?.summaryUpToSeq !== undefined ? `摘要覆盖至 #${data.summaryUpToSeq}` : '',
      data?.memoryUpToSeq !== undefined ? `记忆覆盖至 #${data.memoryUpToSeq}` : '',
      data?.focus ? `本轮输入：${data.focus}` : '',
    ].filter(Boolean).join('\n')
  }
  if (event.type === 'context/summary' || event.type === 'context/memory') return data?.text ?? ''
  if (event.type === 'turn/error') return String(data?.message ?? '')
  if (event.type === 'turn/notice') return String(data?.message ?? data?.kind ?? '')
  return ''
}

export function triggerLabel(trigger?: string) {
  if (trigger === 'manual') return '手动'
  if (trigger === 'overflow') return '溢出恢复'
  return '自动'
}
