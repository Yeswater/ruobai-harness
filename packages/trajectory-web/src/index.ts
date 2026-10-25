import type { Context } from '@ruobai/cordis'
import { HttpError, sendJson } from '@ruobai/web-server'
import type { SessionEvent } from '@ruobai/session'
import type {
  TimingState, TurnsState, UsageState,
} from '@ruobai/trajectory'
import type { RecordsState } from '@ruobai/trajectory'
import type { TrajectoryFrame, TrajectorySnapshot } from '@ruobai/trajectory'

export type * from '@ruobai/trajectory'

export interface Config {
  /** Turns returned by one page / the initial tail. */
  pageTurns?: number
  /** Coalescing window for live frames. */
  frameIntervalMs?: number
}

interface Views {
  turns?: TurnsState
  records?: RecordsState
  timing?: TimingState
  usage?: UsageState
}

interface UiBroadcast {
  broadcast?(channel: string, data: unknown): void
}

function viewsOf(ctx: Context, sessionId: string): Views {
  const view = ctx.sessions.view<Record<string, unknown>>(sessionId)
  if (!view) return {}
  return {
    turns: view['trajectory.turns'] as TurnsState | undefined,
    records: view['trajectory.records'] as RecordsState | undefined,
    timing: view['trajectory.timing'] as TimingState | undefined,
    usage: view['trajectory.usage'] as UsageState | undefined,
  }
}

function snapshot(ctx: Context, sessionId: string, pageTurns: number, before: number | null): TrajectorySnapshot {
  const views = viewsOf(ctx, sessionId)
  const turns = views.turns?.turns ?? []
  const records = views.records?.records ?? []
  const timing = views.timing?.spans ?? []
  const usage = views.usage?.entries ?? []
  const meta = views.records?.meta ?? views.turns?.meta

  const end = before ?? (turns.length ? turns.length + 1 : 0)
  const selected = turns.filter(turn => turn.index < end).slice(-pageTurns)
  const indices = new Set(selected.map(turn => turn.index))
  const firstIndex = selected[0]?.index ?? 0
  const hasMore = turns.some(turn => turn.index < firstIndex)

  return {
    sessionId,
    rev: meta?.rev ?? 0,
    lastSeq: meta?.lastSeq ?? -1,
    generatedAt: Date.now(),
    turns: selected,
    records: records.filter(record => indices.has(record.turn)),
    timing: timing.filter(span => {
      const record = records.find(item => item.id === span.recordId)
      return record ? indices.has(record.turn) : false
    }),
    usage: usage.filter(entry => indices.has(entry.turn)),
    hasMore,
    beforeTurn: hasMore ? firstIndex : null,
  }
}

export default {
  name: 'trajectory-web',
  inject: ['web', 'sessions', 'ui'],
  apply(ctx: Context, config: Config = {}) {
    const pageTurns = config.pageTurns ?? 25
    const interval = config.frameIntervalMs ?? 50
    const lastSent = new Map<string, number>()
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined

    const flush = () => {
      timer = undefined
      const ids = [...pending]
      pending.clear()
      const ui = ctx.get('ui', false) as UiBroadcast | undefined
      if (!ui?.broadcast) return
      for (const id of ids) {
        const views = viewsOf(ctx, id)
        const meta = views.records?.meta
        if (!meta) continue
        const sent = lastSent.get(id) ?? -1
        if (meta.lastSeq <= sent) continue
        lastSent.set(id, meta.lastSeq)
        // The last two turns cover the boundary: a new user message closes the
        // previous turn and opens a new one in the same event.
        const turns = (views.turns?.turns ?? []).slice(-2)
        const indices = new Set(turns.map(turn => turn.index))
        const records = (views.records?.records ?? []).filter(record => indices.has(record.turn)).slice(-300)
        const frame: TrajectoryFrame = {
          sessionId: id,
          rev: meta.rev,
          lastSeq: meta.lastSeq,
          turns,
          records,
        }
        ui.broadcast('trajectory', frame)
      }
    }

    ctx.effect(() => {
      const onEvent = (sessionId: string, _event: SessionEvent) => {
        const meta = ctx.sessions.get(sessionId)?.meta
        if (!meta || meta.kind === 'subagent') return
        pending.add(sessionId)
        timer ??= setTimeout(flush, interval)
      }
      const stop = ctx.on('session/event', onEvent)
      return () => {
        stop()
        if (timer) clearTimeout(timer)
        timer = undefined
        pending.clear()
        lastSent.clear()
      }
    }, 'trajectory-web.frames')

    ctx.effect(() => ctx.web.register({
      prefix: '/api/trajectory',
      handler: async (_req, res, url) => {
        const match = /^\/api\/trajectory\/sessions\/([^/]+)$/.exec(url.pathname)
        if (!match) return false
        const sessionId = decodeURIComponent(match[1]!)
        if (!ctx.sessions.get(sessionId)) throw new HttpError(404, 'session not found')
        const beforeParam = url.searchParams.get('before')
        const before = beforeParam === null ? null : Number(beforeParam)
        if (before !== null && !Number.isFinite(before)) throw new HttpError(400, 'invalid before')
        const limit = Number(url.searchParams.get('tail') ?? pageTurns)
        const page = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : pageTurns
        sendJson(res, 200, { snapshot: snapshot(ctx, sessionId, page, before) })
        return true
      },
    }), 'trajectory-web.routes')
  },
}

export const meta = {
  title: '轨迹传输',
  description: '轨迹快照分页接口与实时增量帧。',
}
