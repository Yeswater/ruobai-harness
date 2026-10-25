import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type TrajectoryEvent } from '../api.ts'
import { BranchIcon, ChevronRightIcon, SearchIcon } from './Icons.tsx'
import {
  TRAJECTORY_LANES, eventKind, eventLabel, eventLane, eventPreview, eventText,
} from './trajectory-helpers.ts'

type Filter = 'all' | 'tools' | 'context'
type Mode = 'sequence' | 'time'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'tools', label: '工具' },
  { id: 'context', label: '上下文' },
]

interface Annotated {
  event: TrajectoryEvent
  turn: number
}

function isToolEvent(event: TrajectoryEvent) {
  return event.type === 'tool/result'
    || (event.type === 'message/assistant'
      && Boolean(event.data?.parts?.some(part => part.type === 'tool-call')))
}

function isContextEvent(event: TrajectoryEvent) {
  return event.type === 'context/summary' || event.type === 'context/memory'
}

function shortTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}min`
}

function annotate(events: TrajectoryEvent[]) {
  let turn = 0
  const titles = new Map<number, string>()
  const rows: Annotated[] = events.map((event) => {
    if (event.type === 'message/user') {
      turn += 1
      const text = (event.data?.text ?? '').replace(/\s+/g, ' ').trim()
      titles.set(turn, text.slice(0, 80))
    }
    return { event, turn }
  })
  return { rows, titles }
}

interface RowProps {
  event: TrajectoryEvent
  open: boolean
  selected: boolean
  args?: string
  durationMs?: number
  onToggle: () => void
}

function EventRow({ event, open, selected, args, durationMs, onToggle }: RowProps) {
  const kind = eventKind(event)
  const body = event.type === 'tool/result' && args
    ? `参数\n${args}\n\n结果\n${eventText(event)}`
    : eventText(event)

  return (
    <>
      <tr
        className={`traj-row kind-${kind} ${selected ? 'selected' : ''}`}
        data-seq={event.seq}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
            keyEvent.preventDefault()
            onToggle()
          }
        }}
      >
        <td className="traj-event-cell">
          <span className={`traj-kind kind-${kind}`}>{eventLabel(event)}</span>
          <span className="traj-seq mono">#{event.seq}</span>
          <span className="traj-time">{shortTime(event.ts)}</span>
        </td>
        <td className="traj-content-cell">
          <span className="traj-preview" title={eventPreview(event)}>{eventPreview(event)}</span>
          {event.type === 'tool/result' && durationMs !== undefined
            ? <span className="traj-chip">{formatDuration(durationMs)}</span>
            : null}
          {event.data?.isError ? <span className="traj-chip error">失败</span> : null}
          <span className={`context-caret ${open ? 'open' : ''}`}>
            <ChevronRightIcon size={11} />
          </span>
        </td>
      </tr>
      {open
        ? (
          <tr className="traj-detail-row">
            <td />
            <td>
              <pre className="traj-detail-body">{body || '（没有可显示的文本内容）'}</pre>
            </td>
          </tr>
        )
        : null}
    </>
  )
}

export function TrajectoryView({ session }: { session: ChatSession | null }) {
  const [events, setEvents] = useState<TrajectoryEvent[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>('sequence')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const ledgerRef = useRef<HTMLDivElement>(null)
  const sessionId = session?.id
  const updatedAt = session?.updatedAt

  useEffect(() => {
    if (!sessionId) {
      setEvents([])
      return
    }
    let cancelled = false
    setLoading(true)
    void api.getTrajectory(sessionId)
      .then((list) => {
        if (cancelled) return
        setEvents(list)
        setError(null)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId, updatedAt, session?.streaming])

  useEffect(() => {
    setExpanded(new Set())
    setSelectedSeq(null)
  }, [sessionId])

  const { rows, titles } = useMemo(() => annotate(events), [events])

  const calls = useMemo(() => {
    const args = new Map<string, string>()
    const starts = new Map<string, number>()
    for (const event of events) {
      if (event.type !== 'message/assistant') continue
      for (const part of event.data?.parts ?? []) {
        if (part.type !== 'tool-call') continue
        const key = part.id ?? part.callId
        if (!key) continue
        if (part.arguments) args.set(key, part.arguments)
        starts.set(key, event.ts)
      }
    }
    return { args, starts }
  }, [events])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter(({ event }) => {
      if (!event.data) return false
      if (event.type === 'session/title' || event.type === 'session/meta') return false
      if (event.type === 'message/user' && event.data.source?.kind === 'skill') return false
      if (filter === 'tools' && !isToolEvent(event)) return false
      if (filter === 'context' && !isContextEvent(event)) return false
      if (!needle) return true
      return `${event.seq} ${event.type} ${eventPreview(event)} ${eventText(event)}`
        .toLowerCase()
        .includes(needle)
    })
  }, [rows, filter, query])

  const groups = useMemo(() => {
    const map = new Map<number, TrajectoryEvent[]>()
    for (const { event, turn } of visible) {
      const list = map.get(turn) ?? []
      list.push(event)
      map.set(turn, list)
    }
    return [...map.entries()].map(([turn, list]) => ({
      turn,
      title: turn ? titles.get(turn) ?? '' : '会话开始前',
      events: list,
    }))
  }, [visible, titles])

  const spans = useMemo(() => {
    const items = visible.map(row => row.event)
    if (!items.length) return []
    if (mode === 'sequence') {
      return items.map((event, index) => ({
        event,
        left: (index / items.length) * 100,
        width: 100 / items.length,
      }))
    }
    const gaps = items.map((event, index) => {
      if (!index) return 1
      return Math.min(Math.max(event.ts - items[index - 1]!.ts, 0), 30_000) + 1
    })
    const total = gaps.reduce((sum, gap) => sum + gap, 0)
    let offset = 0
    return items.map((event, index) => {
      const width = (gaps[index]! / total) * 100
      const left = (offset / total) * 100
      offset += gaps[index]!
      return { event, left, width }
    })
  }, [visible, mode])

  const toggle = (seq: number) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }

  const jump = (seq: number) => {
    setSelectedSeq(seq)
    const row = ledgerRef.current?.querySelector(`[data-seq="${seq}"]`)
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  return (
    <div className="trajectory-view">
      <div className="trajectory-head">
        <div className="trajectory-title">
          <BranchIcon size={14} />
          <span>会话轨迹</span>
          <span className="trajectory-count">{events.length} 条事件</span>
          {loading ? <span className="trajectory-count">加载中…</span> : null}
        </div>
        <div className="trajectory-actions">
          <div className="trajectory-filters" role="tablist" aria-label="轨迹筛选">
            {FILTERS.map(item => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                className={filter === item.id ? 'active' : ''}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="traj-search">
            <SearchIcon size={12} />
            <input
              value={query}
              placeholder="搜索轨迹"
              aria-label="搜索轨迹"
              onChange={event => setQuery(event.target.value)}
            />
          </label>
        </div>
      </div>

      {error ? <div className="trajectory-empty error">{error}</div> : null}
      {!error && !visible.length
        ? (
          <div className="trajectory-empty">
            {loading ? '正在读取会话日志…' : query || filter !== 'all' ? '没有匹配的事件。' : '本会话还没有可展示的轨迹。'}
          </div>
        )
        : null}

      {visible.length
        ? (
          <>
            <div className="traj-overview">
              <div className="traj-overview-head">
                <span className="traj-overview-title">时间线</span>
                <span className="traj-overview-count">{visible.length} / {events.length} 条</span>
                <span className="spacer" />
                <div className="traj-mode" role="group" aria-label="时间线刻度">
                  <button
                    type="button"
                    className={mode === 'sequence' ? 'active' : ''}
                    onClick={() => setMode('sequence')}
                  >
                    序列
                  </button>
                  <button
                    type="button"
                    className={mode === 'time' ? 'active' : ''}
                    onClick={() => setMode('time')}
                  >
                    时长
                  </button>
                </div>
              </div>
              <div className="traj-timeline">
                {TRAJECTORY_LANES.map(lane => (
                  <div className="traj-lane" key={lane.id}>
                    <span className="traj-lane-label">{lane.label}</span>
                    <div className="traj-lane-track">
                      {spans
                        .filter(span => eventLane(span.event) === lane.id)
                        .map(span => (
                          <button
                            key={span.event.seq}
                            type="button"
                            className={`traj-span kind-${eventKind(span.event)} ${selectedSeq === span.event.seq ? 'selected' : ''}`}
                            style={{ left: `${span.left}%`, width: `max(2px, ${span.width}%)` }}
                            title={`${eventLabel(span.event)} #${span.event.seq} · ${eventPreview(span.event)}`}
                            aria-label={`${eventLabel(span.event)} #${span.event.seq}`}
                            onClick={() => jump(span.event.seq)}
                          />
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="traj-ledger" ref={ledgerRef}>
              <table className="traj-table">
                <colgroup>
                  <col className="traj-col-event" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>事件</th>
                    <th>内容</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(group => (
                    <Fragment key={group.turn}>
                      <tr className="traj-turn-row">
                        <th colSpan={2}>
                          <div className="traj-turn-head">
                            <span className="traj-turn-badge">{group.turn ? `第 ${group.turn} 轮` : '开始'}</span>
                            <span className="traj-turn-title" title={group.title}>{group.title}</span>
                            <span className="traj-turn-count">{group.events.length} 条</span>
                          </div>
                        </th>
                      </tr>
                      {group.events.map((event) => {
                        const callId = event.type === 'tool/result' ? event.data?.callId : undefined
                        const start = callId ? calls.starts.get(callId) : undefined
                        return (
                          <EventRow
                            key={event.seq}
                            event={event}
                            open={expanded.has(event.seq)}
                            selected={selectedSeq === event.seq}
                            args={callId ? calls.args.get(callId) : undefined}
                            durationMs={start !== undefined ? event.ts - start : undefined}
                            onToggle={() => toggle(event.seq)}
                          />
                        )
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
        : null}
    </div>
  )
}
