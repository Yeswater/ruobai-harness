import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { ignoredPath } from '@ruobai/commit-prompt/message'
import {
  api,
  type CheckpointChange,
  type GitChange,
  type GitCommit,
  type GitInfo,
} from '../api.ts'
import { CreatePrDialog } from './CreatePrDialog.tsx'
import { CommitBar } from './git/CommitBar.tsx'
import { DiffPane } from './git/DiffPane.tsx'
import { countDiff } from './git/model.ts'
import { FolderIcon } from './Icons.tsx'

type Filter = 'working' | 'session'

interface Row {
  path: string
  added: number
  removed: number
  untracked?: boolean
  tool?: string
}

interface DiffState {
  path: string
  diff?: string
  binary?: boolean
  loading?: boolean
  error?: string
}

/**
 * Full-pane changes view: files on the left (working tree or everything this
 * session wrote), the selected patch on the right, recent commits underneath.
 */
export function ChangesView({ session }: { session: ChatSession | null }) {
  const [filter, setFilter] = useState<Filter>('working')
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [changes, setChanges] = useState<GitChange[]>([])
  const [checkpoints, setCheckpoints] = useState<CheckpointChange[]>([])
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [selected, setSelected] = useState<{ path: string; kind: Filter } | null>(null)
  const [diff, setDiff] = useState<DiffState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [prOpen, setPrOpen] = useState(false)
  const request = useRef(0)

  const load = useCallback(async () => {
    if (!session) return
    setError(null)
    try {
      const [status, sessionChanges, log] = await Promise.all([
        api.getGitStatus(session.id),
        api.getCheckpoints(session.id),
        api.getGitLog(session.id, { limit: 6 }),
      ])
      setInfo(status.info)
      setChanges(status.changes)
      setCheckpoints(sessionChanges)
      setCommits(log.commits)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [session?.id])

  useEffect(() => {
    void load()
  }, [load, session?.streaming])

  const workingRows = useMemo<Row[]>(() => changes.map(change => ({
    path: change.path,
    added: (change.stagedStat?.added ?? 0) + (change.worktreeStat?.added ?? 0),
    removed: (change.stagedStat?.removed ?? 0) + (change.worktreeStat?.removed ?? 0),
    untracked: change.untracked,
  })), [changes])

  const sessionRows = useMemo<Row[]>(() => {
    const latest = new Map<string, CheckpointChange>()
    for (const change of checkpoints) latest.set(change.path, change)
    return [...latest.values()]
      .sort((left, right) => right.seq - left.seq)
      .map((change) => {
        const stats = change.diff ? countDiff(change.diff) : { added: 0, removed: 0 }
        return { path: change.path, added: stats.added, removed: stats.removed, tool: change.tool }
      })
  }, [checkpoints])

  const rows = filter === 'working' ? workingRows : sessionRows
  const grouped = useMemo(() => groupRows(rows), [rows])

  const showDiff = useCallback(async (path: string, kind: Filter) => {
    if (!session) return
    const ticket = request.current + 1
    request.current = ticket
    setSelected({ path, kind })
    if (kind === 'session') {
      const change = checkpoints.filter(item => item.path === path).at(-1)
      if (change?.diff !== undefined) {
        setDiff({ path, diff: change.diff })
        return
      }
    }
    setDiff({ path, loading: true })
    try {
      const change = changes.find(item => item.path === path)
      const result = await api.getGitDiff(session.id, {
        path,
        scope: change?.staged && !change.unstaged ? 'staged' : 'working',
      })
      if (request.current !== ticket) return
      setDiff({ path, diff: result.diff, binary: result.binary })
    } catch (caught) {
      if (request.current !== ticket) return
      setDiff({ path, error: caught instanceof Error ? caught.message : String(caught) })
    }
  }, [session?.id, checkpoints, changes])

  // Follow the filter: keep a valid selection, otherwise pick the first file.
  useEffect(() => {
    if (!session) return
    if (selected && rows.some(row => row.path === selected.path)) {
      if (selected.kind === filter) return
    }
    const first = rows[0]
    if (!first) {
      setSelected(null)
      setDiff(null)
      return
    }
    void showDiff(first.path, filter)
    // Selection is reconciled when the filter or the row set changes.
  }, [filter, rows.length, session?.id])

  const workingSet = useMemo(() => new Set(workingRows.map(row => row.path)), [workingRows])
  // AGENTS §9: secrets, session logs and build output are never committed.
  const commitPaths = useMemo(
    () => workingRows.map(row => row.path).filter(path => !ignoredPath(path)),
    [workingRows],
  )
  const skippedCount = workingRows.length - commitPaths.length
  const prFiles = (filter === 'working' ? workingRows : sessionRows.map(row => row.path))
    .map(row => typeof row === 'string' ? row : row.path)
    .filter(path => workingSet.has(path) && !ignoredPath(path))

  if (!session) return <div className="changes-view"><div className="loading">no session</div></div>

  const upstream = info?.upstream?.replace(/^[^/]+\//, '') || 'main'

  return (
    <div className="changes-view">
      <aside className="changes-side">
        <div className="changes-head">
          <span className="changes-title">{filter === 'working' ? '未提交的更改' : '所有更改'}</span>
          <span className="changes-count">{rows.length}</span>
          <button className="session-link" onClick={() => void load()}>刷新</button>
          <button
            className="btn primary compact"
            disabled={!prFiles.length}
            title={prFiles.length ? '提交当前列表并创建 PR' : '当前列表没有未提交的改动'}
            onClick={() => setPrOpen(true)}
          >
            创建 PR
          </button>
        </div>

        <CommitBar
          sessionId={session.id}
          paths={commitPaths}
          onChanged={load}
          onNotice={setNotice}
          onError={setError}
        />

        <div className="changes-files">
          {notice ? <div className="changes-note success">{notice}</div> : null}
          {skippedCount
            ? (
              <div className="changes-note">
                已排除 {skippedCount} 个不提交的文件（.env、.sessions、.ruobai、dist 等）
              </div>
            )
            : null}
          {error ? <div className="changes-note error">{error}</div> : null}
          {!error && !rows.length
            ? <div className="changes-note">{filter === 'working' ? '没有未提交的改动' : '本次会话还没有文件改动'}</div>
            : null}
          {grouped.map(([dir, items]) => (
            <div className="changes-group" key={dir || '.'}>
              {dir
                ? (
                  <div className="changes-group-head">
                    <FolderIcon size={12} />
                    <span>{dir}</span>
                  </div>
                )
                : null}
              {items.map(row => (
                <button
                  key={row.path}
                  className={`changes-file ${selected?.path === row.path ? 'active' : ''}`}
                  onClick={() => void showDiff(row.path, filter)}
                  title={row.path}
                >
                  <span className="changes-file-name">{basename(row.path)}</span>
                  <span className="changes-file-stats">
                    <span className="session-add">+{row.added}</span>
                    <span className="session-del">−{row.removed}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="changes-filters">
          <button className={filter === 'working' ? 'active' : ''} onClick={() => setFilter('working')}>
            未提交的更改 <span>{workingRows.length}</span>
          </button>
          <button className={filter === 'session' ? 'active' : ''} onClick={() => setFilter('session')}>
            所有更改 <span>{sessionRows.length}</span>
          </button>
        </div>

        <div className="changes-commits">
          <div className="changes-commits-head">
            <span>提交</span>
            <span className="changes-count">{commits.length}</span>
          </div>
          {commits.map(commit => (
            <div className="changes-commit" key={commit.hash} title={`${commit.author} · ${commit.date}`}>
              <code>{commit.shortHash}</code>
              <span className="changes-commit-subject">{commit.subject}</span>
              <time>{ago(commit.date)}</time>
            </div>
          ))}
        </div>
      </aside>

      <section className="changes-diff">
        <DiffPane
          path={diff?.path ?? selected?.path ?? '选择文件查看改动'}
          diff={diff?.diff}
          binary={diff?.binary}
          loading={diff?.loading}
          error={diff?.error}
          badge={selected?.kind === 'session' ? '会话改动' : '工作区'}
        />
      </section>

      {prOpen
        ? (
          <CreatePrDialog
            sessionId={session.id}
            files={prFiles}
            title={defaultPrTitle(session.title)}
            base={upstream}
            onClose={() => setPrOpen(false)}
          />
        )
        : null}
    </div>
  )
}

function groupRows(rows: Row[]): Array<[string, Row[]]> {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const index = row.path.lastIndexOf('/')
    const dir = index < 0 ? '' : row.path.slice(0, index)
    const list = groups.get(dir)
    if (list) list.push(row)
    else groups.set(dir, [row])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dir, items]) => [dir, [...items].sort((left, right) => left.path.localeCompare(right.path))])
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

function defaultPrTitle(title: string) {
  const cleaned = title.trim().replace(/\s+/g, ' ')
  return cleaned ? `feat: ${cleaned.slice(0, 60)}` : 'feat: 更新'
}

function ago(iso: string) {
  const delta = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(delta) || delta < 0) return ''
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
