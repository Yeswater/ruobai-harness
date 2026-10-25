import { describe, expect, it } from 'vitest'
import { statsItems } from '../src/components/StatsLine.tsx'

const context = {
  estimatedTokens: 24_000,
  compactAt: 48_000,
  summaries: 0,
  breakdown: { messages: 0, systemPrompt: 0, systemTools: 0, mcpTools: 0 },
  mcpTools: [],
}

describe('stats line', () => {
  it('formats speed, cache hit and context usage', () => {
    const items = statsItems(
      { outputTokens: 100, generationMs: 2000, inputTokens: 100, cachedInputTokens: 50 },
      context,
    )
    expect(items.map(item => item.label)).toEqual(['50 tok/s', '缓存命中 50%', '上下文 50%'])
  })

  it('shows placeholders when a metric is unavailable', () => {
    const items = statsItems(null, null)
    expect(items.map(item => item.label)).toEqual(['— tok/s', '缓存命中 —', '上下文 —'])
  })

  it('prefers the configured model context window', () => {
    const items = statsItems(null, { ...context, contextWindow: 96_000 })
    expect(items[2]?.label).toBe('上下文 25%')
  })

  it('divides only the tokens that were actually streamed', () => {
    // 1200 output tokens across three steps, but only the 2s window of streamed
    // text can be timed: dividing the total would report an impossible rate.
    const items = statsItems(
      { outputTokens: 1200, streamedOutputTokens: 200, generationMs: 2000, inputTokens: 100 },
      context,
    )
    expect(items[0]?.label).toBe('100 tok/s')
  })

  it('ignores buffered streams with no measurable window', () => {
    const items = statsItems(
      { outputTokens: 400, streamedOutputTokens: 400, generationMs: 40 },
      context,
    )
    expect(items[0]?.label).toBe('— tok/s')
  })

  it('shows a reported zero instead of a placeholder', () => {
    const items = statsItems(
      { outputTokens: 10, generationMs: 1000, inputTokens: 1000, cachedInputTokens: 0 },
      context,
    )
    expect(items[1]?.label).toBe('缓存命中 0%')
  })

  it('drops a cache figure that cannot fit inside the prompt', () => {
    const items = statsItems(
      { outputTokens: 10, generationMs: 1000, inputTokens: 1000, cachedInputTokens: 4000 },
      context,
    )
    expect(items[1]?.label).toBe('缓存命中 —')
  })

  it('rejects non-numeric provider noise', () => {
    const items = statsItems(
      {
        outputTokens: Number.NaN,
        streamedOutputTokens: 10,
        generationMs: Number.POSITIVE_INFINITY,
        inputTokens: 0,
        cachedInputTokens: 10,
      },
      context,
    )
    expect(items[0]?.label).toBe('— tok/s')
    expect(items[1]?.label).toBe('缓存命中 —')
  })
})
