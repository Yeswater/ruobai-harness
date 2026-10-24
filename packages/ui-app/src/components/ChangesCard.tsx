import { useState } from 'react'
import { api, type GitInfo } from '../api.ts'

interface ChangesCardProps {
  sessionId?: string
  git: GitInfo | null
  onRefresh: () => void
}

export function ChangesCard({ sessionId, git, onRefresh }: ChangesCardProps) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async () => {
    if (!sessionId || !message.trim()) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.commitWorkspace(sessionId, message.trim())
      setNotice(`已提交 ${result.commit}`)
      setOpen(false)
      setMessage('')
      onRefresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="changes-summary">
        <span className="changes-files">
          {!git
            ? '正在读取 Git 状态…'
            : !git.available
              ? '当前工作区不是 Git 仓库'
              : git.files
                ? `${git.files} 个文件有改动`
                : '没有未提交的改动'}
        </span>
        {git?.available && (git.files > 0)
          ? (
            <span className="changes-stats">
              <span className="add">+{git.added}</span>
              <span className="del">-{git.removed}</span>
            </span>
          )
          : null}
        <span className="spacer" />
        <button
          type="button"
          className="btn compact"
          disabled={!git?.available || !git.files || busy}
          onClick={() => setOpen(true)}
        >
          提交更改
        </button>
      </div>

      {notice ? <div className="detail-note">{notice}</div> : null}
      {error && !open ? <div className="detail-note error">{error}</div> : null}

      {open
        ? (
          <div className="modal-backdrop" onClick={() => !busy && setOpen(false)}>
            <div
              className="modal commit-modal"
              role="dialog"
              aria-modal="true"
              aria-label="提交更改"
              onClick={event => event.stopPropagation()}
            >
              <div className="modal-head">
                <h2>提交更改</h2>
              </div>
              <div className="modal-body">
                <p className="modal-note">
                  会把当前工作区的全部 {git?.files ?? 0} 个文件改动暂存，并提交到分支 {git?.branch ?? '当前分支'}。
                </p>
                <textarea
                  className="commit-message"
                  value={message}
                  autoFocus
                  rows={4}
                  placeholder="提交说明"
                  onChange={event => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void submit()
                    }
                  }}
                />
                {error ? <div className="detail-note error">{error}</div> : null}
              </div>
              <div className="modal-foot">
                <span className="spacer" />
                <div className="modal-actions">
                  <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>取消</button>
                  <button className="btn" disabled={busy || !message.trim()} onClick={() => void submit()}>
                    {busy ? '提交中…' : '提交'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
        : null}
    </>
  )
}
