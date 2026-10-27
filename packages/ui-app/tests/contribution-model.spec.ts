import { describe, expect, it } from 'vitest'
import {
  buildContributionWeeks, contributionLevel, parseDayKey,
} from '../src/contribution-model.ts'

function daysFrom(start: string, length: number, count = (index: number) => index) {
  return Array.from({ length }, (_, index) => {
    const date = parseDayKey(start)
    date.setDate(date.getDate() + index)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return { date: key, count: count(index) }
  })
}

describe('contribution levels', () => {
  it('keeps empty days at zero and scales the rest to the busiest day', () => {
    expect(contributionLevel(0, 10)).toBe(0)
    expect(contributionLevel(1, 10)).toBe(1)
    expect(contributionLevel(4, 10)).toBe(2)
    expect(contributionLevel(6, 10)).toBe(3)
    expect(contributionLevel(9, 10)).toBe(4)
  })

  it('treats a single contribution as the darkest step when it is the max', () => {
    expect(contributionLevel(1, 1)).toBe(1)
    expect(contributionLevel(0, 1)).toBe(0)
  })
})

describe('contribution weeks', () => {
  it('pads the first and last week so every column holds seven days', () => {
    // 2026-05-04 is a Monday: the leading column needs one blank day.
    const weeks = buildContributionWeeks(daysFrom('2026-05-04', 14), 13)
    expect(weeks).toHaveLength(3)
    expect(weeks.every(week => week.cells.length === 7)).toBe(true)
    expect(weeks[0]!.cells[0]).toBeNull()
    expect(weeks[0]!.cells[1]?.date).toBe('2026-05-04')
    expect(weeks.at(-1)!.cells.filter(cell => cell === null)).toHaveLength(6)
    expect(weeks.flatMap(week => week.cells).filter(Boolean)).toHaveLength(14)
  })

  it('labels the first week of each month', () => {
    const weeks = buildContributionWeeks(daysFrom('2026-05-25', 21), 3)
    expect(weeks.map(week => week.label)).toEqual(['5月', undefined, '6月', undefined])
  })

  it('returns nothing for an empty window', () => {
    expect(buildContributionWeeks([], 0)).toEqual([])
  })
})
