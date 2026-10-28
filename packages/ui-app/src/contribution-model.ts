import type { ActivityDay } from './api.ts'

export interface ContributionCell {
  date: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

export interface ContributionWeek {
  key: string
  /** Month name shown above the first week of that month, e.g. `6月`. */
  label?: string
  cells: Array<ContributionCell | null>
}

/** Five visual steps, scaled to the busiest day in the window. */
export function contributionLevel(count: number, max: number): ContributionCell['level'] {
  if (count <= 0) return 0
  if (max <= 1) return 1
  const ratio = count / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/** Parse `YYYY-MM-DD` as a local date; `new Date(key)` would read it as UTC. */
export function parseDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1)
}

/**
 * Lay days out in week columns starting on Sunday, padding the first and last
 * week so every column holds exactly seven days.
 */
export function buildContributionWeeks(days: ActivityDay[], max: number): ContributionWeek[] {
  if (!days.length) return []
  const cells: Array<ContributionCell | null> = days.map(day => ({
    date: day.date,
    count: day.count,
    level: contributionLevel(day.count, max),
  }))
  const lead = parseDayKey(days[0]!.date).getDay()
  for (let index = 0; index < lead; index += 1) cells.unshift(null)
  while (cells.length % 7) cells.push(null)

  const weeks: ContributionWeek[] = []
  let previousMonth = -1
  for (let index = 0; index < cells.length; index += 7) {
    const slice = cells.slice(index, index + 7)
    const anchor = slice.find(cell => cell !== null) ?? null
    const key = anchor?.date ?? `week-${index / 7}`
    if (!anchor) {
      weeks.push({ key, cells: slice })
      continue
    }
    const month = parseDayKey(anchor.date).getMonth()
    const week: ContributionWeek = { key, cells: slice }
    if (month !== previousMonth) {
      week.label = `${month + 1}月`
      previousMonth = month
    }
    weeks.push(week)
  }
  return weeks
}
