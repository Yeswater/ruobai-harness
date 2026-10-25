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
  if (event.type === 'message/user') return 'user'
  if (event.type === 'message/assistant') return 'assistant'
  if (event.type === 'tool/result') return 'tool'
  if (event.type === 'turn/error') return 'error'
  if (event.type === 'context/summary' || event.type === 'context/memory') return 'context'
  return 'notice'
}

export function eventLabel(event: TrajectoryEvent) {
  switch (event.type) {
    case 'message/user': return '用户'
    case 'message/assistant': return '助手'
    case 'tool/result': return '工具'
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
    return (data?.text ?? '').replace(/\s+/g, ' ').slice(0, 140)
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
