import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type GitCommit } from '../../api.ts'
import { RefreshIcon, SearchIcon } from '../Icons.tsx'
import type { HistoryFilter } from './BranchTree.tsx'
import { computeGraph, parseRef, relativeTime, type GraphRow } from './model.ts'

const PAGE_SIZE = 40

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const lane = 11
  const height = 26
  const total = Math.max(width, 1) * lane
  return (
    <svg className="git-graph" width={total} height={height} viewBox={`0 0 ${total} ${height}`} aria-hidden>
      {row.segments.map((segment, index) => (
        <line
          key={index}
          x1={segment.x1 * lane + lane / 2}
          y1={segment.y1 * height}
          x2={segment.x2 * lane + lane / 2}
          y2={segment.y2 * height}
          stroke={`var(--graph-${segment.color % 6})`}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      ))}
      <circle
        cx={row.dot * lane + lane / 2}
        cy={height / 2}
        r={3.2}
        fill={`var(--graph-${row.dot % 6})`}
        stroke="var(--panel)"
        strokeWidth={1}
      />
    </svg>
  )
}

export function RefBadge({ refName, remotes }: { refName: string; remotes: string[] }) {
  const ref = parseRef(refName, remotes)
  return <span className={`git-ref git-ref-${ref.kind}`}>{ref.label}</span>
}

interface HistoryListProps {
  sessionId: string
  filter: HistoryFilter
  revision: number
  remotes: string[]
  selectedHash: string | null
  /** True when the layout has room for a detail pane and nothing is selected. */
  autoSelect: boolean
  onSelect: (hash: string) => void
  onError: (text: string | null) => void
}

/** Commit list with graph lanes; selection is rendered by the detail pane. */
export function HistoryList({
  sessionId, filter, revision, remotes, selectedHash, autoSelect, onSelect, onError,
}: HistoryListProps) {
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [refresh, setRefresh] = useState(0)
  const requestRef = useRef(0)
  const autoRef = useRef('')

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])

  const load = useCallback(async (skip: number) => {
    const request = requestRef.current + 1
    requestRef.current = request
    setLoading(true)
    setError(null)
    onError(null)
    try {
      const result = await api.getGitLog(sessionId, {
        limit: PAGE_SIZE,
        skip,
        all: filter.all,
        ref: filter.ref ?? undefined,
        q: debounced || undefined,
      })
      if (requestRef.current !== request) return
      setCommits(current => (skip === 0 ? result.commits : [...current, ...result.commits]))
      setHasMore(result.hasMore)
    } catch (caught) {
      if (requestRef.current === request) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (requestRef.current === request) setLoading(false)
    }
  }, [sessionId, filter.all, filter.ref, debounced])

  useEffect(() => {
    void load(0)
  }, [load, revision, refresh])

  useEffect(() => {
    if (!autoSelect || selectedHash || !commits.length) return
    const key = `${filter.all}:${filter.ref ?? ''}:${commits[0]!.hash}`
    if (autoRef.current === key) return
    autoRef.current = key
    onSelect(commits[0]!.hash)
  }, [autoSelect, selectedHash, commits, filter.all, filter.ref, onSelect])

  const graph = useMemo(() => computeGraph(commits), [commits])
  const graphWidth = useMemo(
    () => graph.reduce((width, row) => Math.max(width, row.width), 1),
    [graph],
  )

  return (
    <section className="git-nav-section">
      <div className="git-nav-head">
        <span className="git-nav-title">提交历史</span>
        <span className="git-count">{commits.length}</span>
        <span className="spacer" />
        <button
          className="icon-btn subtle"
          title="刷新"
          aria-label="刷新提交历史"
          disabled={loading}
          onClick={() => setRefresh(current => current + 1)}
        >
          <RefreshIcon size={12} />
        </button>
      </div>

      <div className="git-log-filters">
        <span className="git-search">
          <SearchIcon size={12} />
          <input
            value={query}
            placeholder="搜索提交信息或哈希"
            aria-label="搜索提交"
            onChange={event => setQuery(event.target.value)}
          />
        </span>
        <span className="git-filter-chip" title="当前历史范围">
          {filter.all ? '所有分支' : filter.ref ?? '当前分支'}
        </span>
      </div>

      {error ? <div className="detail-note error">{error}</div> : null}

      <div className="git-log-list" role="listbox" aria-label="提交历史">
        {commits.map((commit, index) => {
          const row = graph[index] ?? { width: 1, dot: 0, segments: [] }
          return (
            <button
              key={commit.hash}
              role="option"
              aria-selected={selectedHash === commit.hash}
              className={`git-log-row ${selectedHash === commit.hash ? 'selected' : ''}`}
              onClick={() => onSelect(commit.hash)}
            >
              <GraphCell row={row} width={graphWidth} />
              <span className="git-log-text">
                <span className="git-log-subject-row">
                  {commit.refs.map(refName => (
                    <RefBadge key={refName} refName={refName} remotes={remotes} />
                  ))}
                  <span className="git-log-subject" title={commit.subject}>{commit.subject}</span>
                </span>
                <span className="git-log-meta">
                  <span className="git-log-hash">{commit.shortHash}</span>
                  <span>{commit.author}</span>
                  <span>{relativeTime(commit.date)}</span>
                </span>
              </span>
            </button>
          )
        })}
        {!commits.length && !loading ? <div className="detail-note">没有匹配的提交。</div> : null}
      </div>

      {hasMore
        ? (
          <button
            className="btn ghost compact git-load-more"
            disabled={loading}
            onClick={() => void load(commits.length)}
          >
            {loading ? '加载中…' : '加载更多'}
          </button>
        )
        : null}
    </section>
  )
}
