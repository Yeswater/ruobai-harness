/**
 * Daily contribution counts for the empty-session graph.
 *
 * A "contribution" is a user message: it is the one thing a person directly
 * does in a session, so counting it keeps the graph honest. Injected prompts
 * (goal steps, plan continuations) carry `data.source.kind` and are skipped,
 * as are sub-agent sessions, which nobody typed into.
 */

const WINDOW_DAYS = 365

export interface ActivityDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  count: number
}

export interface ActivitySummary {
  /** One entry per day in the window, oldest first, zero-filled. */
  days: ActivityDay[]
  /** User messages in the window. */
  total: number
  /** Highest single-day count; the graph scales its darkest step to this. */
  max: number
  start: string
  end: string
}

export interface ActivityEvent {
  type: string
  ts: number
  data?: { source?: { kind?: string } }
}

export interface ActivitySession {
  kind?: string
  events: ActivityEvent[]
}

/** Local date key: the browser and the host share a timezone, so both agree. */
export function localDayKey(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Walk back from `end` local midnight; per-day `setDate` stays DST-correct. */
function dayWindow(end: number): string[] {
  const keys: string[] = []
  for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(end)
    date.setDate(date.getDate() - offset)
    keys.push(localDayKey(date.getTime()))
  }
  return keys
}

export function summarizeActivity(sessions: ActivitySession[], now = Date.now()): ActivitySummary {
  const end = startOfDay(now)
  const keys = dayWindow(end)
  const slot = new Map(keys.map((key, index) => [key, index]))
  const counts = new Array<number>(keys.length).fill(0)

  for (const session of sessions) {
    if (session.kind === 'subagent') continue
    for (const event of session.events) {
      if (event.type !== 'message/user' || event.data?.source?.kind) continue
      const index = slot.get(localDayKey(event.ts))
      if (index !== undefined) counts[index] += 1
    }
  }

  const total = counts.reduce((sum, count) => sum + count, 0)
  return {
    days: keys.map((date, index) => ({ date, count: counts[index]! })),
    total,
    max: counts.reduce((max, count) => Math.max(max, count), 0),
    start: keys[0]!,
    end: keys[keys.length - 1]!,
  }
}
