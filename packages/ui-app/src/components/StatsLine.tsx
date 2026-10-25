import type { TurnStats } from '@ruobai/chat-protocol'
import type { ContextInfo } from '../api.ts'
import { WorkspaceBadge } from './WorkspaceBadge.tsx'

interface StatsLineProps {
  stats?: TurnStats | null
  contextInfo: ContextInfo | null
  sessionId?: string
  workspace?: string
}

/** Below this the stream window is pure noise (buffered or single-frame answers). */
const MIN_SPEED_WINDOW_MS = 250

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

/**
 * Tokens per second for the last turn.
 *
 * The numerator must be the tokens generated inside the measured window:
 * `outputTokens` spans every step of the turn (including tool round trips),
 * which is why `streamedOutputTokens` is preferred and the bare total is only a
 * fallback for stats recorded before the split existed.
 */
export function tokensPerSecond(stats: TurnStats | null | undefined): number | undefined {
  const generationMs = finite(stats?.generationMs)
  if (generationMs === undefined || generationMs < MIN_SPEED_WINDOW_MS) return undefined
  const tokens = finite(stats?.streamedOutputTokens) ?? finite(stats?.outputTokens)
  if (tokens === undefined || tokens <= 0) return undefined
  return tokens / (generationMs / 1000)
}

/** Share of the prompt billed as cache reads, repaired into 0–100%. */
export function cacheHitRate(stats: TurnStats | null | undefined): number | undefined {
  const input = finite(stats?.inputTokens)
  const cached = finite(stats?.cachedInputTokens)
  if (input === undefined || input <= 0 || cached === undefined || cached < 0) return undefined
  // Providers that bill cache reads on top of the prompt are normalized in the
  // adapter; anything still overflowing here is provider noise, not a real 100%.
  if (cached > input) return undefined
  return (cached / input) * 100
}

export function statsItems(stats: TurnStats | null | undefined, contextInfo: ContextInfo | null) {
  const speed = tokensPerSecond(stats)
  const cacheHit = cacheHitRate(stats)
  const contextPercent = contextInfo
    ? Math.min(100, Math.round(
      (contextInfo.estimatedTokens / Math.max(1, contextInfo.contextWindow ?? contextInfo.compactAt)) * 100,
    ))
    : undefined

  return [
    {
      key: 'speed',
      label: speed !== undefined ? `${Math.round(speed)} tok/s` : '— tok/s',
      title: '本回合流式生成速度',
    },
    {
      key: 'cache',
      label: cacheHit !== undefined ? `缓存命中 ${Math.round(cacheHit)}%` : '缓存命中 —',
      title: '提供方返回的缓存命中率',
    },
    {
      key: 'context',
      label: contextPercent !== undefined ? `上下文 ${contextPercent}%` : '上下文 —',
      title: '上下文占用 / 压缩阈值',
    },
  ]
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
