import type { TurnStats } from '@ruobai/chat-protocol'
import type { ContextInfo } from '../api.ts'

interface StatsLineProps {
  stats?: TurnStats | null
  contextInfo: ContextInfo | null
}

export function statsItems(stats: TurnStats | null | undefined, contextInfo: ContextInfo | null) {
  const tokensPerSecond = stats?.outputTokens !== undefined
    && stats.generationMs !== undefined
    && stats.generationMs >= 300
    ? stats.outputTokens / (stats.generationMs / 1000)
    : undefined
  const cacheHit = stats?.cachedInputTokens !== undefined && stats.inputTokens
    ? Math.min(100, (stats.cachedInputTokens / stats.inputTokens) * 100)
    : undefined
  const contextPercent = contextInfo
    ? Math.min(100, Math.round((contextInfo.estimatedTokens / Math.max(1, contextInfo.compactAt)) * 100))
    : undefined

  return [
    {
      key: 'speed',
      label: tokensPerSecond !== undefined ? `${Math.round(tokensPerSecond)} tok/s` : '— tok/s',
      title: '本回合生成速度',
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

export function StatsLine({ stats, contextInfo }: StatsLineProps) {
  const items = statsItems(stats, contextInfo)

  return (
    <div className="stats-line">
      {items.map((item, index) => (
        <span key={item.key} className="stats-item" title={item.title}>
          {index ? <span className="stats-sep">·</span> : null}
          {item.label}
        </span>
      ))}
    </div>
  )
}
