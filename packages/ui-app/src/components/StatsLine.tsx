import type { TurnStats } from '@ruobai/chat-protocol'
import type { ContextInfo } from '../api.ts'
import { WorkspaceBadge } from './WorkspaceBadge.tsx'

interface StatsLineProps {
  stats?: TurnStats | null
  contextInfo: ContextInfo | null
  sessionId?: string
  workspace?: string
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

/**
 * Decode throughput for the last turn.
 *
 * Numerator and denominator must describe the same work: `streamedOutputTokens`
 * covers exactly the steps that also reported a decode window, so it is read
 * first and the turn-wide `outputTokens` is only a fallback for logs written
 * before that split existed.
 */
export function tokensPerSecond(stats: TurnStats | null | undefined): number | undefined {
  const generationMs = finite(stats?.generationMs)
  if (generationMs === undefined || generationMs <= 0) return undefined
  const tokens = finite(stats?.streamedOutputTokens) ?? finite(stats?.outputTokens)
  if (tokens === undefined || tokens <= 0) return undefined
  return tokens / (generationMs / 1000)
}

/** Billed prompt tokens: uncached input plus everything served from cache. */
export function billedInputTokens(stats: TurnStats | null | undefined): number {
  return (finite(stats?.inputTokens) ?? 0)
    + (finite(stats?.cachedInputTokens) ?? 0)
    + (finite(stats?.cacheWriteInputTokens) ?? 0)
}

/** Share of the billed prompt served from cache, 0–100. */
export function cacheHitRate(stats: TurnStats | null | undefined): number | undefined {
  const billed = billedInputTokens(stats)
  const cached = finite(stats?.cachedInputTokens)
  if (billed <= 0 || cached === undefined || cached < 0) return undefined
  return Math.min(100, (cached / billed) * 100)
}

export interface StatsItem {
  key: 'speed' | 'cache' | 'tokens' | 'context'
  label: string
  title: string
}

/** Compact token count: 517 / 12.2k / 1.2m. */
export function formatTokens(value: number): string {
  const scaled = (input: number) => (input >= 100 ? String(Math.round(input)) : String(Math.round(input * 10) / 10))
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${scaled(value / 1_000)}k`
  return `${scaled(value / 1_000_000)}m`
}

/**
 * Build the stats strip.
 *
 * A figure with no recorded value is dropped instead of printed as a dash: a
 * row of `—` reads like a broken build, while a shorter strip reads like a
 * session that has not billed anything yet. Every figure here rides the durable
 * log, so a reload or a paged transcript shows the same numbers.
 */
export function statsItems(stats: TurnStats | null | undefined, contextInfo: ContextInfo | null): StatsItem[] {
  const items: StatsItem[] = []
  const speed = tokensPerSecond(stats)
  const cacheHit = cacheHitRate(stats)
  const outputTokens = finite(stats?.outputTokens)
  const contextPercent = contextInfo
    ? Math.min(100, Math.round(
      (contextInfo.estimatedTokens / Math.max(1, contextInfo.contextWindow ?? contextInfo.compactAt)) * 100,
    ))
    : undefined

  if (speed !== undefined) {
    items.push({
      key: 'speed',
      label: `${Math.round(speed)} tok/s`,
      title: '本回合解码速度（解码 token / 解码耗时）',
    })
  }
  if (cacheHit !== undefined) {
    items.push({
      key: 'cache',
      label: `缓存命中 ${Math.round(cacheHit)}%`,
      title: '缓存读取 token 占计费输入 token 的比例',
    })
  }
  if (billedInputTokens(stats) > 0 || outputTokens !== undefined) {
    items.push({
      key: 'tokens',
      label: `输入 ${formatTokens(billedInputTokens(stats))} · 输出 ${formatTokens(outputTokens ?? 0)}`,
      title: '最近一回合的计费 token',
    })
  }
  if (contextPercent !== undefined) {
    items.push({
      key: 'context',
      label: `上下文 ${contextPercent}%`,
      title: '上下文占用 / 压缩阈值',
    })
  }
  return items
}

export function StatsLine({ stats, contextInfo, sessionId, workspace }: StatsLineProps) {
  const items = statsItems(stats, contextInfo)

  return (
    <div className="stats-line">
      <WorkspaceBadge sessionId={sessionId} workspace={workspace} />
      {items.map(item => (
        <span key={item.key} className="stats-item" title={item.title}>
          <span className="stats-sep">·</span>
          {item.label}
        </span>
      ))}
    </div>
  )
}
