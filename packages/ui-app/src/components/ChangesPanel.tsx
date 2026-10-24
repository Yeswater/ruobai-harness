import { useEffect, useState } from 'react'
import { api, type SessionChange } from '../api.ts'
import { DiffView } from './DiffView.tsx'

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

export function ChangesPanel({ sessionId }: { sessionId: string }) {
  const [changes, setChanges] = useState<SessionChange[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  const load = async () => {
    try {
      setChanges(await api.getSessionChanges(sessionId))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    if (!sessionId) {
      setChanges([])
      return
    }
    setOpen(null)
    setNotice(null)
    void load()
    const timer = setInterval(() => { void load() }, 3_000)
    return () => clearInterval(timer)
  }, [sessionId])

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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  if (!sessionId) return <div className="loading">no session</div>

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <span className="changes-count">
          {changes.length ? `${changes.length} 个文件有改动` : '没有未回退的改动'}
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => revert()} disabled={!changes.length || busy !== null}>
          {busy === 'all' ? '回退中…' : '全部回退'}
        </button>
      </div>

      <div className="detail-note">
        只记录 write_file / edit_file 的改动；通过 bash 修改的文件不会被记录。
      </div>

      {error ? <div className="detail-note error">{error}</div> : null}
      {notice ? <div className="detail-note">{notice}</div> : null}

      {changes.map(change => {
        const { added, removed } = counts(change.diff)
        const expanded = open === change.seq
        return (
          <div className="change-row" key={change.seq}>
            <button className="change-head" onClick={() => setOpen(expanded ? null : change.seq)}>
              <span className="change-path">{change.path}</span>
              <span className="change-stats">
                <span className="add">+{added}</span>
                <span className="del">-{removed}</span>
              </span>
              <span className="change-meta">{change.tool} · {new Date(change.at).toLocaleTimeString()}</span>
            </button>

            {expanded ? (
              <>
                {change.diff
                  ? <DiffView diff={change.diff} />
                  : <div className="detail-note">没有可显示的 diff。</div>}
                <div className="change-actions">
                  <button
                    className="btn ghost danger"
                    onClick={() => revert(change.seq - 1)}
                    disabled={busy !== null}
                  >
                    {busy === String(change.seq - 1) ? '回退中…' : '回退到此改动之前'}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
