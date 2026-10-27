import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api } from '../api.ts'
import type {
  TrajectoryFrame, TrajectoryRecord, TrajectorySnapshot, TurnSummary,
} from '@ruobai/trajectory/types'
import { ChevronRightIcon, SearchIcon } from './Icons.tsx'

type Filter = 'all' | 'tools' | 'context'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'tools', label: '工具' },
  { id: 'context', label: '上下文' },
]

const KIND_LABEL: Record<string, string> = {
  system: '系统',
  user: '用户',
  context: '上下文',
  compacted: '压缩',
  assistant: '助手',
  tool: '工具',
  subtool: '子工具',
  memory: '长期记忆',
  wiki: '知识库',
}

function formatTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function duration(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}min`
}

function recordMs(record: TrajectoryRecord) {
  const { startedAt, completedAt } = record.timing ?? {}
  return startedAt !== undefined && completedAt !== undefined ? completedAt - startedAt : undefined
}

function turnMs(turn: TurnSummary) {
  return turn.endedAt !== undefined ? turn.endedAt - turn.startedAt : undefined
}

function tokensLabel(turn: TurnSummary) {
  const { input, output, cacheRead } = turn.tokens
  const parts = []
  if (input) parts.push(`↑${formatTokens(input)}`)
  if (output) parts.push(`↓${formatTokens(output)}`)
  if (cacheRead) parts.push(`cache ${formatTokens(cacheRead)}`)
  return parts.join(' ')
}

function turnTitle(turn: TurnSummary) {
  return turn.index === 0 ? '会话开始前' : turn.title || `第 ${turn.index} 轮`
}

function mergeFrame(previous: TrajectorySnapshot, frame: TrajectoryFrame): TrajectorySnapshot {
  const turns = previous.turns.slice()
  for (const turn of frame.turns) {
    const index = turns.findIndex(item => item.index === turn.index)
    if (index >= 0) turns[index] = turn
    else turns.push(turn)
  }
  turns.sort((a, b) => a.index - b.index)
  const affected = new Set(frame.turns.map(turn => turn.index))
  const records = [
    ...previous.records.filter(record => !affected.has(record.turn)),
    ...frame.records,
  ].sort((a, b) => a.turn - b.turn || a.seq - b.seq)
  return { ...previous, rev: frame.rev, lastSeq: frame.lastSeq, turns, records }
}

function prependSnapshot(previous: TrajectorySnapshot, older: TrajectorySnapshot): TrajectorySnapshot {
  const seenTurns = new Set(previous.turns.map(turn => turn.index))
  const turns = [...older.turns.filter(turn => !seenTurns.has(turn.index)), ...previous.turns]
  const seenRecords = new Set(previous.records.map(record => record.id))
  const records = [...older.records.filter(record => !seenRecords.has(record.id)), ...previous.records]
  return {
    ...previous,
    turns,
    records,
    hasMore: older.hasMore,
    beforeTurn: older.beforeTurn,
    rev: Math.max(previous.rev, older.rev),
  }
}

function defaultCollapsed(turns: TurnSummary[]) {
  const last = turns.at(-1)?.index
  return new Set(turns.filter(turn => turn.index !== last).map(turn => turn.index))
}

function anchorOf(container: HTMLElement) {
  const box = container.getBoundingClientRect()
  for (const row of container.querySelectorAll<HTMLElement>('[data-record-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > box.top) return { id: row.dataset.recordId, offset: rect.top - box.top }
  }
  for (const turn of container.querySelectorAll<HTMLElement>('[data-turn]')) {
    const rect = turn.getBoundingClientRect()
    if (rect.bottom > box.top) return { turn: Number(turn.dataset.turn), offset: rect.top - box.top }
  }
  return null
}

interface InspectorProps {
  record?: TrajectoryRecord
  turn?: TurnSummary
  streaming: boolean
  onClear: () => void
}

function Inspector({ record, turn, streaming, onClear }: InspectorProps) {
  if (!record) {
    return (
      <div className="tp-inspector-empty">
        {turn
          ? (
            <>
              <h3>{turnTitle(turn)}</h3>
              <dl className="tp-facts">
                <div><dt>状态</dt><dd>{streaming ? '进行中' : turn.status === 'error' ? '错误' : '完成'}</dd></div>
                <div><dt>记录</dt><dd>{turn.recordCount} 条 · {turn.toolCount} 次工具</dd></div>
                <div><dt>请求</dt><dd>{turn.stepCount} 步</dd></div>
                <div><dt>耗时</dt><dd>{duration(turnMs(turn)) || '—'}</dd></div>
                <div><dt>tokens</dt><dd>{tokensLabel(turn) || '—'}</dd></div>
              </dl>
            </>
          )
          : <p>还没有可展示的记录。</p>}
        <p className="tp-hint">选择左侧一条记录查看详情。</p>
      </div>
    )
  }
  const meta = [
    KIND_LABEL[record.kind] ?? record.kind,
    `#${record.seq}`,
    record.turn ? `第 ${record.turn} 轮` : '开始前',
    record.step ? `第 ${record.step} 步` : '',
  ].filter(Boolean)
  return (
    <div className="tp-inspector-body">
      <header className="tp-inspector-head">
        <div>
          <h3>{KIND_LABEL[record.kind] ?? record.kind}</h3>
          <p className="tp-hint">{meta.join(' · ')}</p>
        </div>
        <button type="button" className="sandbox-link" onClick={onClear}>清除</button>
      </header>
      <dl className="tp-facts">
        <div><dt>时间</dt><dd>{new Date(record.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</dd></div>
        {recordMs(record) !== undefined ? <div><dt>耗时</dt><dd>{duration(recordMs(record))}</dd></div> : null}
        {record.usage
          ? <div><dt>tokens</dt><dd>↑{formatTokens(record.usage.input ?? 0)} ↓{formatTokens(record.usage.output ?? 0)}</dd></div>
          : null}
        {record.toolName ? <div><dt>工具</dt><dd className="mono">{record.toolName}</dd></div> : null}
        {record.isError ? <div><dt>状态</dt><dd className="tp-danger">失败</dd></div> : null}
      </dl>
      <pre className="tp-detail">{record.detail || record.preview || '（没有更多内容）'}</pre>
    </div>
  )
}

export function TrajectoryView({ session }: { session: ChatSession | null }) {
  const [snapshot, setSnapshot] = useState<TrajectorySnapshot | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasNew, setHasNew] = useState(false)
  const [follow, setFollow] = useState(false)
  const ledgerRef = useRef<HTMLDivElement>(null)
  const anchorApplied = useRef(false)
  const anchorPending = useRef<{ id?: string; turn?: number; offset: number } | null>(null)
  const followPending = useRef(false)
  const followRef = useRef(follow)
  const lastTurnRef = useRef(-1)
  followRef.current = follow
  lastTurnRef.current = snapshot?.turns.at(-1)?.index ?? -1
  const sessionId = session?.id

  useEffect(() => {
    setSnapshot(null)
    setCollapsed(new Set())
    setSelectedId(null)
    setQuery('')
    setFilter('all')
    setHasNew(false)
    setFollow(false)
    setError(null)
    anchorApplied.current = false
    anchorPending.current = null
    if (!sessionId) return
    let cancelled = false
    setLoading(true)
    void api.getTrajectorySnapshot(sessionId)
      .then((next) => {
        if (cancelled) return
        setSnapshot(next)
        setCollapsed(defaultCollapsed(next.turns))
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    const source = new EventSource('/api/events')
    const onFrame = (message: MessageEvent) => {
      let frame: TrajectoryFrame
      try {
        frame = JSON.parse(message.data) as TrajectoryFrame
      } catch {
        return
      }
      if (frame.sessionId !== sessionId) return
      const previousLast = lastTurnRef.current
      const opened = frame.turns.some(turn => turn.index > previousLast)
      if (opened && previousLast >= 0) {
        setCollapsed((current) => new Set(current).add(previousLast))
      }
      setSnapshot((current) => current ? mergeFrame(current, frame) : current)
      if (followRef.current) {
        followPending.current = true
        setHasNew(false)
      } else {
        setHasNew(true)
      }
    }
    source.addEventListener('trajectory', onFrame as EventListener)
    return () => source.close()
  }, [sessionId])

  useLayoutEffect(() => {
    const container = ledgerRef.current
    if (!container || !snapshot || anchorApplied.current) return
    const last = snapshot.turns.at(-1)
    if (!last) {
      anchorApplied.current = true
      return
    }
    const target = container.querySelector<HTMLElement>(`[data-turn="${last.index}"]`)
    if (target) container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top
    anchorApplied.current = true
    // Short histories fit the viewport: the turn-top anchor is also the tail,
    // so live records may follow from the start. A long turn keeps it off
    // until the reader scrolls down, otherwise the anchor would be fought.
    if (container.scrollHeight - container.scrollTop - container.clientHeight < 48) setFollow(true)
  }, [snapshot])

  useLayoutEffect(() => {
    const container = ledgerRef.current
    if (container && follow) container.scrollTop = container.scrollHeight
    followPending.current = false
  }, [snapshot, follow])

  useLayoutEffect(() => {
    const anchor = anchorPending.current
    const container = ledgerRef.current
    if (!anchor || !container) return
    anchorPending.current = null
    const target = anchor.id
      ? container.querySelector<HTMLElement>(`[data-record-id="${anchor.id}"]`)
      : anchor.turn !== undefined
        ? container.querySelector<HTMLElement>(`[data-turn="${anchor.turn}"]`)
        : null
    if (target) {
      container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
    }
  }, [collapsed, snapshot])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const map = new Map<number, TrajectoryRecord[]>()
    for (const record of snapshot?.records ?? []) {
      if (filter === 'tools' && record.kind !== 'tool') continue
      if (filter === 'context'
        && record.kind !== 'context'
        && record.kind !== 'compacted'
        && record.kind !== 'memory'
        && record.kind !== 'wiki') continue
      if (needle) {
        const haystack = `${record.preview} ${record.detail ?? ''} ${record.toolName ?? ''}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      const list = map.get(record.turn) ?? []
      list.push(record)
      map.set(record.turn, list)
    }
    return map
  }, [snapshot, filter, query])

  const filtering = Boolean(query.trim()) || filter !== 'all'
  const turns = useMemo(() => (snapshot?.turns ?? []).filter((turn) => {
    if (!filtering) return true
    return (rows.get(turn.index)?.length ?? 0) > 0
  }), [snapshot, rows, filtering])

  const selected = useMemo(
    () => snapshot?.records.find(record => record.id === selectedId),
    [snapshot, selectedId],
  )
  const latest = snapshot?.turns.at(-1)

  const toggleTurn = useCallback((index: number) => {
    const container = ledgerRef.current
    if (container) anchorPending.current = anchorOf(container)
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
    if (index === lastTurnRef.current) setFollow(false)
  }, [])

  const loadOlder = useCallback(async () => {
    if (!sessionId || !snapshot?.hasMore || snapshot.beforeTurn === null) return
    const container = ledgerRef.current
    if (container) anchorPending.current = anchorOf(container)
    setLoadingOlder(true)
    try {
      const older = await api.getTrajectorySnapshot(sessionId, { before: snapshot.beforeTurn })
      setSnapshot((current) => current ? prependSnapshot(current, older) : older)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoadingOlder(false)
    }
  }, [sessionId, snapshot])

  const onScroll = useCallback(() => {
    const container = ledgerRef.current
    if (!container) return
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 48
    setFollow(nearBottom)
    if (nearBottom) setHasNew(false)
  }, [])

  const selectRecord = useCallback((record: TrajectoryRecord) => {
    setSelectedId((current) => current === record.id ? null : record.id)
  }, [])

  return (
    <div className="tp-root">
      <div className="trajectory-head">
        <div className="trajectory-title">
          <span>会话轨迹</span>
          <span className="trajectory-count">{snapshot?.records.length ?? 0} 条记录 · {snapshot?.turns.length ?? 0} 轮</span>
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
      {!error && !loading && snapshot && !snapshot.records.length
        ? <div className="trajectory-empty">本会话还没有可展示的轨迹。</div>
        : null}

      <div className="tp-body">
        <div className="tp-ledger" ref={ledgerRef} onScroll={onScroll}>
          {loading && !snapshot
            ? Array.from({ length: 6 }, (_, index) => <div className="tp-skeleton" key={index} />)
            : null}
          {turns.map((turn) => {
            const open = filtering || !collapsed.has(turn.index)
            const list = rows.get(turn.index) ?? []
            return (
              <section className="tp-turn" key={turn.index} data-turn={turn.index}>
                <button
                  type="button"
                  className="tp-turn-head"
                  aria-expanded={open}
                  onClick={() => toggleTurn(turn.index)}
                >
                  <span className={`tp-caret ${open ? 'open' : ''}`}><ChevronRightIcon size={11} /></span>
                  <span className="tp-turn-badge">{turn.index === 0 ? '开始' : `第 ${turn.index} 轮`}</span>
                  <span className="tp-turn-title" title={turn.title}>{turnTitle(turn)}</span>
                  <span className="tp-turn-meta">
                    {turn.recordCount} 条
                    {turnMs(turn) !== undefined ? ` · ${duration(turnMs(turn))}` : ''}
                    {tokensLabel(turn) ? ` · ${tokensLabel(turn)}` : ''}
                  </span>
                </button>
                {open
                  ? list.map(record => (
                    <button
                      type="button"
                      key={record.id}
                      className={`tp-row ${selectedId === record.id ? 'selected' : ''}`}
                      data-record-id={record.id}
                      data-turn={record.turn}
                      onClick={() => selectRecord(record)}
                    >
                      <span className={`tp-kind kind-${record.kind}`}>{KIND_LABEL[record.kind] ?? record.kind}</span>
                      <span className="tp-seq">#{record.seq}</span>
                      <span className="tp-preview" title={record.preview}>{record.preview || '（空）'}</span>
                      {recordMs(record) !== undefined
                        ? <span className="tp-chip">{duration(recordMs(record))}</span>
                        : record.isError ? <span className="tp-chip error">失败</span> : <span />}
                    </button>
                  ))
                  : null}
                {open && filtering && !list.length ? <div className="tp-hint tp-row-empty">没有匹配的记录</div> : null}
              </section>
            )
          })}
          {snapshot?.hasMore
            ? (
              <div className="tp-footer">
                <button type="button" className="tp-load" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? '加载中…' : '加载更早的历史'}
                </button>
              </div>
            )
            : null}
          {hasNew
            ? <button type="button" className="tp-new" onClick={() => setFollow(true)}>有新记录 · 跟随尾部</button>
            : null}
        </div>

        <aside className="tp-inspector">
          <Inspector
            record={selected}
            turn={latest}
            streaming={Boolean(session?.streaming)}
            onClear={() => setSelectedId(null)}
          />
        </aside>
      </div>
    </div>
  )
}
