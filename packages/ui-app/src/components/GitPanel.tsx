import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type GitFile, type GitInfo, type SessionChange } from '../api.ts'
import { BranchIcon, ChevronDownIcon } from './Icons.tsx'
import { DiffView } from './DiffView.tsx'

interface GitPanelProps {
  sessionId: string
  git: GitInfo | null
  onRefresh: () => void
}

function counts(diff?: string) {
  let added = 0
  let removed = 0
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

function statusClass(status: string) {
  if (status === 'A' || status === '?') return 'add'
  if (status === 'D') return 'del'
  if (status === 'R' || status === 'C') return 'ren'
  return 'mod'
}

/**
 * Source control for the session workspace: working-tree files and the
 * session's own checkpoints share one commit/rollback surface.
 */
export function GitPanel({ sessionId, git, onRefresh }: GitPanelProps) {
  const [files, setFiles] = useState<GitFile[]>([])
  const [changes, setChanges] = useState<SessionChange[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextFiles, nextChanges] = await Promise.all([
        api.getGitFiles(sessionId),
        api.getSessionChanges(sessionId),
      ])
      setFiles(nextFiles)
      setChanges(nextChanges)
      setSelected((previous) => {
        const next: Record<string, boolean> = {}
        for (const file of nextFiles) next[file.path] = previous[file.path] ?? true
        return next
      })
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [sessionId])

  useEffect(() => {
    setExpanded(null)
    setDiffs({})
    setNotice(null)
    setMessage('')
    setSelected({})
    void load()
    const timer = setInterval(() => { void load() }, 4_000)
    return () => clearInterval(timer)
  }, [load])

  const chosen = useMemo(
    () => files.filter(file => selected[file.path]).map(file => file.path),
    [files, selected],
  )
  const allSelected = files.length > 0 && chosen.length === files.length

  const toggleAll = () => {
    const next: Record<string, boolean> = {}
    for (const file of files) next[file.path] = !allSelected
    setSelected(next)
  }

  const toggleFile = async (path: string) => {
    const key = `file:${path}`
    if (expanded === key) {
      setExpanded(null)
      return
    }
    setExpanded(key)
    if (diffs[key] !== undefined) return
    try {
      const result = await api.getGitDiff(sessionId, path)
      setDiffs(current => ({ ...current, [key]: result.diff }))
    } catch (caught) {
      setDiffs(current => ({ ...current, [key]: '' }))
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const submit = async () => {
    if (!message.trim() || !chosen.length) return
    setBusy('commit')
    setError(null)
    setNotice(null)
    try {
      const result = await api.commitWorkspace(sessionId, message.trim(), chosen)
      setNotice(`已提交 ${result.commit}`)
      setMessage('')
      setDiffs({})
      await load()
      onRefresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const revert = async (upToSeq?: number) => {
    setBusy(upToSeq === undefined ? 'all' : String(upToSeq))
    setError(null)
    setNotice(null)
    try {
      const result = await api.revertSessionChanges(sessionId, upToSeq)
      const skipped = result.skipped.length
        ? `；${result.skipped.length} 个文件未回退：${result.skipped.map(item => `${item.path}（${item.reason}）`).join('，')}`
        : ''
      setNotice(`已回退 ${result.reverted.length} 个文件${skipped}`)
      await load()
      onRefresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="git-panel">
      <div className="git-branch-row">
        <BranchIcon size={13} />
        <span className="git-branch" title={git?.branch ?? ''}>{git?.branch ?? (git?.available === false ? '不是 Git 仓库' : '—')}</span>
        {git?.ahead ? <span className="git-sync" title="领先上游的提交">↑{git.ahead}</span> : null}
        {git?.behind ? <span className="git-sync" title="落后上游的提交">↓{git.behind}</span> : null}
        <span className="spacer" />
        <button className="btn ghost compact" onClick={() => { void load(); onRefresh() }} disabled={busy !== null}>
          刷新
        </button>
      </div>

      {files.length
        ? (
          <>
            <textarea
              className="commit-message inline"
              value={message}
              rows={2}
              placeholder="提交说明，⌘Enter 提交选中的文件"
              onChange={event => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <div className="git-commit-row">
              <label className="git-select">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                全选
              </label>
              <span className="git-count">{chosen.length}/{files.length}</span>
              <span className="spacer" />
              <button
                className="btn compact"
                disabled={busy !== null || !message.trim() || !chosen.length}
                onClick={() => void submit()}
              >
                {busy === 'commit' ? '提交中…' : '提交'}
              </button>
            </div>
          </>
        )
        : null}

      {error ? <div className="detail-note error">{error}</div> : null}
      {notice ? <div className="detail-note">{notice}</div> : null}

      <div className="git-section">
        <div className="git-section-head">
          <span>工作区改动</span>
          <span className="git-count">{files.length}</span>
        </div>
        {files.length
          ? files.map((file) => {
            const key = `file:${file.path}`
            const open = expanded === key
            const diff = diffs[key]
            const { added, removed } = counts(diff)
            return (
              <div className={`git-file ${open ? 'open' : ''}`} key={file.path}>
                <div className="git-file-head">
                  <input
                    type="checkbox"
                    checked={Boolean(selected[file.path])}
                    onChange={() => setSelected(current => ({ ...current, [file.path]: !current[file.path] }))}
                    aria-label={`选择 ${file.path}`}
                  />
                  <span className={`git-status git-status-${statusClass(file.status)}`}>{file.status}</span>
                  <button className="git-file-open" onClick={() => { void toggleFile(file.path) }}>
                    <span className="git-file-path" title={file.path}>{file.path}</span>
                    {diff ? (
                      <span className="change-stats">
                        <span className="add">+{added}</span>
                        <span className="del">-{removed}</span>
                      </span>
                    ) : null}
                    <ChevronDownIcon size={12} />
                  </button>
                </div>
                {open
                  ? diff === undefined
                    ? <div className="detail-note">正在读取 diff…</div>
                    : diff
                      ? <DiffView diff={diff} />
                      : <div className="detail-note">没有可显示的 diff（二进制或空文件）。</div>
                  : null}
              </div>
            )
          })
          : (
            <div className="detail-note">
              {git?.available === false ? '当前工作区不是 Git 仓库。' : '工作区没有未提交的改动。'}
            </div>
          )}
        {git?.available && files.length
          ? (
            <div className="git-stats">
              <span className="add">+{git.added}</span>
              <span className="del">-{git.removed}</span>
              <span className="git-stats-note">相对 HEAD</span>
            </div>
          )
          : null}
      </div>

      <div className="git-section">
        <div className="git-section-head">
          <span>本会话改动</span>
          <span className="git-count">{changes.length}</span>
          <span className="spacer" />
          <button
            className="btn ghost compact"
            onClick={() => void revert()}
            disabled={!changes.length || busy !== null}
          >
            {busy === 'all' ? '回退中…' : '全部回退'}
          </button>
        </div>
        {changes.length
          ? changes.map((change) => {
            const key = `seq:${change.seq}`
            const open = expanded === key
            const { added, removed } = counts(change.diff)
            return (
              <div className="change-row" key={change.seq}>
                <button
                  className="change-head"
                  onClick={() => setExpanded(open ? null : key)}
                >
                  <span className="change-path">{change.path}</span>
                  <span className="change-stats">
                    <span className="add">+{added}</span>
                    <span className="del">-{removed}</span>
                  </span>
                  <span className="change-meta">{change.tool} · {new Date(change.at).toLocaleTimeString()}</span>
                </button>
                {open
                  ? (
                    <>
                      {change.diff
                        ? <DiffView diff={change.diff} />
                        : <div className="detail-note">没有可显示的 diff。</div>}
                      <div className="change-actions">
                        <button
                          className="btn ghost danger"
                          onClick={() => void revert(change.seq - 1)}
                          disabled={busy !== null}
                        >
                          {busy === String(change.seq - 1) ? '回退中…' : '回退到此改动之前'}
                        </button>
                      </div>
                    </>
                  )
                  : null}
              </div>
            )
          })
          : <div className="detail-note">本会话还没有可回退的文件改动。</div>}
        <div className="detail-note">
          只记录 write_file / edit_file 的改动；bash 修改的文件请在上面的工作区改动里查看。
        </div>
      </div>
    </div>
  )
}
