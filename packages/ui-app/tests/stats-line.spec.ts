import { describe, expect, it } from 'vitest'
import { statsItems } from '../src/components/StatsLine.tsx'

describe('stats line', () => {
  it('formats speed, cache hit and context usage', () => {
    const items = statsItems(
      { outputTokens: 100, generationMs: 2000, inputTokens: 100, cachedInputTokens: 50 },
      { estimatedTokens: 24_000, compactAt: 48_000, summaries: 0, breakdown: { messages: 0, systemPrompt: 0, systemTools: 0, mcpTools: 0 }, mcpTools: [] },
    )
    expect(items.map(item => item.label)).toEqual(['50 tok/s', '缓存命中 50%', '上下文 50%'])
  })

  it('shows placeholders when a metric is unavailable', () => {
    const items = statsItems(null, null)
    expect(items.map(item => item.label)).toEqual(['— tok/s', '缓存命中 —', '上下文 —'])
  })
})
