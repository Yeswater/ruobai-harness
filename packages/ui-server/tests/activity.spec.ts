import { describe, expect, it } from 'vitest'
import { summarizeActivity } from '../src/activity.ts'

const NOON = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12).getTime()

function userMessage(ts: number, source?: { kind: string }) {
  return { type: 'message/user', ts, ...(source ? { data: { source } } : {}) }
}

describe('activity summary', () => {
  it('counts user messages per local day and zero-fills the window', () => {
    const now = NOON(2026, 5, 20)
    const summary = summarizeActivity([
      { events: [userMessage(NOON(2026, 5, 20)), userMessage(NOON(2026, 5, 20)), userMessage(NOON(2026, 5, 19))] },
    ], now)

    expect(summary.days).toHaveLength(365)
    expect(summary.end).toBe('2026-05-20')
    expect(summary.start).toBe('2025-05-21')
    expect(summary.days.at(-1)).toEqual({ date: '2026-05-20', count: 2 })
    expect(summary.days.at(-2)).toEqual({ date: '2026-05-19', count: 1 })
    expect(summary.total).toBe(3)
    expect(summary.max).toBe(2)
  })

  it('ignores injected prompts, sub-agent sessions and days outside the window', () => {
    const now = NOON(2026, 5, 20)
    const summary = summarizeActivity([
      {
        events: [
          userMessage(NOON(2026, 5, 20)),
          userMessage(NOON(2026, 5, 20), { kind: 'goal' }),
          { type: 'message/assistant', ts: NOON(2026, 5, 20) },
          userMessage(NOON(2024, 1, 1)),
        ],
      },
      { kind: 'subagent', events: [userMessage(NOON(2026, 5, 20))] },
    ], now)

    expect(summary.total).toBe(1)
    expect(summary.days.at(-1)?.count).toBe(1)
  })

  it('reports an empty year without throwing', () => {
    const summary = summarizeActivity([], NOON(2026, 5, 20))
    expect(summary.total).toBe(0)
    expect(summary.max).toBe(0)
    expect(summary.days.every(day => day.count === 0)).toBe(true)
  })
})
