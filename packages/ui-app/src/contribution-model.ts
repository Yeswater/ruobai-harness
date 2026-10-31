import type { ActivityDay } from './api.ts'

export interface ContributionCell {
  date: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

export interface ContributionWeek {
  key: string
  /** Month name shown above the column that holds the month's first day. */
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
  for (let index = 0; index < cells.length; index += 7) {
    const slice = cells.slice(index, index + 7)
    const anchor = slice.find(cell => cell !== null) ?? null
    const key = anchor?.date ?? `week-${index / 7}`
    const week: ContributionWeek = { key, cells: slice }
    // Label the column that holds the month's first day. Consecutive firsts
    // are 28–31 days apart, i.e. four 12px columns, while the widest label
    // (`12月`) renders ~22px: anchored this way two labels cannot collide, no
    // matter where the window starts.
    const first = slice.find(cell => cell?.date.endsWith('-01'))
    if (first) week.label = `${parseDayKey(first.date).getMonth() + 1}月`
    weeks.push(week)
  }
  return weeks
}
