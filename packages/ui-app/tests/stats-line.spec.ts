import { describe, expect, it } from 'vitest'
import { cacheHitRate, statsItems, tokensPerSecond } from '../src/components/StatsLine.tsx'

const context = {
  estimatedTokens: 24_000,
  compactAt: 48_000,
  summaries: 0,
  breakdown: { messages: 0, systemPrompt: 0, systemTools: 0, mcpTools: 0 },
  mcpTools: [],
}

const labels = (stats: Parameters<typeof statsItems>[0], info: Parameters<typeof statsItems>[1] = context) =>
  statsItems(stats, info).map(item => item.label)

describe('stats line', () => {
  it('reports decode speed, cache hit, billing and context', () => {
    expect(labels({
      inputTokens: 60,
      cachedInputTokens: 40,
      outputTokens: 100,
      streamedOutputTokens: 100,
      generationMs: 2000,
    })).toEqual(['50 tok/s', '缓存命中 40%', '输入 100 · 输出 100', '上下文 50%'])
  })

  it('shows only what the session has recorded', () => {
    // No dash placeholders: an unrecorded figure is absent, not "—".
    expect(labels(null, null)).toEqual([])
    expect(labels({}, context)).toEqual(['上下文 50%'])
    expect(labels({ outputTokens: 12 })).toEqual(['输入 0 · 输出 12', '上下文 50%'])
  })

  it('divides only the tokens decoded inside the measured window', () => {
    // 1200 output tokens across the turn, but only 200 were decoded inside the
    // timed window: dividing the total would invent a rate.
    expect(tokensPerSecond({ outputTokens: 1200, streamedOutputTokens: 200, generationMs: 2000 }))
      .toBe(100)
  })

  it('needs a positive decode window', () => {
    expect(tokensPerSecond({ outputTokens: 400, streamedOutputTokens: 400, generationMs: 0 }))
      .toBeUndefined()
    expect(tokensPerSecond({ outputTokens: 400, streamedOutputTokens: 400 })).toBeUndefined()
    expect(tokensPerSecond({ streamedOutputTokens: 0, generationMs: 1000 })).toBeUndefined()
  })

  it('counts cache reads and writes in the hit-ratio denominator', () => {
    // Disjoint counts: 50 uncached + 50 cached + 100 written = 200 billed.
    expect(cacheHitRate({ inputTokens: 50, cachedInputTokens: 50, cacheWriteInputTokens: 100 }))
      .toBe(25)
    expect(cacheHitRate({ inputTokens: 90, cachedInputTokens: 10 })).toBe(10)
    expect(cacheHitRate({ inputTokens: 100, cachedInputTokens: 0 })).toBe(0)
  })

  it('has no ratio without a billed prompt', () => {
    // Cache-only billing is a full hit; an empty record has no denominator.
    expect(cacheHitRate({ cachedInputTokens: 10 })).toBe(100)
    expect(cacheHitRate({})).toBeUndefined()
  })

  it('prefers the configured model context window', () => {
    const items = statsItems(null, { ...context, contextWindow: 96_000 })
    expect(items.at(-1)?.label).toBe('上下文 25%')
  })
})
