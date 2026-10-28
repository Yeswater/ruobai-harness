import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api.ts'

interface CreatePrDialogProps {
  sessionId: string
  files: string[]
  title: string
  base: string
  onClose: () => void
  onCreated?: (url: string) => void
}

/**
 * Commit the listed files to a fresh branch, push it and open a pull request.
 *
 * The file list comes from the active changes filter, so unrelated staged work
 * in the same checkout is never swept into the commit (`git commit -- <paths>`).
 */
export function CreatePrDialog({ sessionId, files, title: initialTitle, base: initialBase, onClose, onCreated }: CreatePrDialogProps) {
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState('')
  const [branch, setBranch] = useState(() => defaultBranch(initialTitle))
  const [base, setBase] = useState(initialBase || 'main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const submit = async () => {
    if (busy || !files.length) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.createPull(sessionId, {
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        branch: branch.trim(),
        base: base.trim(),
        files,
      })
      setResult(created.url)
      onCreated?.(created.url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-backdrop confirm-backdrop" onClick={() => { if (!busy) onClose() }}>
      <div
        className="modal confirm-modal pr-modal"
        role="dialog"
        aria-modal="true"
        aria-label="创建 PR"
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-head"><h2>创建 PR</h2></div>
        <div className="modal-body">
          {result
            ? (
              <div className="pr-result">
                <p>PR 已创建。</p>
                <a href={result} target="_blank" rel="noreferrer">{result}</a>
              </div>
            )
            : (
              <div className="pr-form">
                <label>
                  <span>标题 *</span>
                  <input ref={inputRef} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：feat: 调整侧栏布局" />
                </label>
                <label>
                  <span>描述</span>
                  <textarea value={body} onChange={event => setBody(event.target.value)} rows={4} placeholder="可选。会写进提交正文与 PR 描述。" />
                </label>
                <div className="pr-row">
                  <label>
                    <span>新分支 *</span>
                    <input value={branch} onChange={event => setBranch(event.target.value)} />
                  </label>
                  <label>
                    <span>基础分支 *</span>
                    <input value={base} onChange={event => setBase(event.target.value)} />
                  </label>
                </div>
                <p className="modal-note">
                  {files.length
                    ? `将提交当前列表中的 ${files.length} 个文件；其他未列出的改动不受影响。`
                    : '当前列表没有未提交的改动，无法创建 PR。'}
                </p>
                {error ? <div className="pr-error">{error}</div> : null}
              </div>
            )}
        </div>
        <div className="modal-foot confirm-foot">
          <div className="modal-actions">
            {result
              ? <button className="btn" onClick={onClose}>完成</button>
              : (
                <>
                  <button className="btn ghost" disabled={busy} onClick={onClose}>取消</button>
                  <button className="btn" disabled={busy || !files.length || !title.trim() || !branch.trim() || !base.trim()} onClick={() => void submit()}>
                    {busy ? '正在创建…' : '创建 PR'}
                  </button>
                </>
              )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function defaultBranch(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `rbh/${slug || 'change'}`
}
