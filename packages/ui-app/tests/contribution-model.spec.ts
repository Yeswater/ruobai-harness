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

  it('labels the column that holds the first day of each month', () => {
    // 2026-05-31 is a Sunday, so its column starts in May but the label sits on
    // the next column, where 6月 1日 lands.
    const weeks = buildContributionWeeks(daysFrom('2026-05-31', 35), 3)
    expect(weeks.map(week => week.label)).toEqual(['6月', undefined, undefined, undefined, '7月'])
  })

  it('never anchors two labels closer than a month apart', () => {
    // A year of columns: 28 days is the shortest month, four columns of twelve
    // pixels against a 22px widest label, so no label can reach its neighbour.
    const weeks = buildContributionWeeks(daysFrom('2025-10-31', 365), 3)
    const anchored = weeks.flatMap((week, index) => week.label ? [index] : [])
    expect(anchored.length).toBeGreaterThanOrEqual(12)
    for (let index = 1; index < anchored.length; index += 1) {
      expect(anchored[index]! - anchored[index - 1]!).toBeGreaterThanOrEqual(4)
    }
  })

  it('drops the stub month at the window start', () => {
    // The window opens on 1月 15日, so 1月 1日 is outside it: the first label
    // is 2月, and the stub columns keep their cells and lose only their label.
    const weeks = buildContributionWeeks(daysFrom('2026-01-15', 120), 3)
    expect(weeks.map(week => week.label)).not.toContain('1月')
    expect(weeks.findIndex(week => week.label) ).toBe(3)
    expect(weeks[3]!.label).toBe('2月')
  })

  it('returns nothing for an empty window', () => {
    expect(buildContributionWeeks([], 0)).toEqual([])
  })
})
