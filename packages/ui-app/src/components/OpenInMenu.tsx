import { useEffect, useRef, useState } from 'react'
import { api, type EditorChoice } from '../api.ts'
import { ChevronDownIcon, ExternalLinkIcon } from './Icons.tsx'

interface OpenInMenuProps {
  sessionId?: string
  workspace?: string
}

/**
 * "Open in editor": detects local IDE/editor CLIs and gives the user a choice.
 * The first detected editor is the default action.
 */
export function OpenInMenu({ sessionId, workspace }: OpenInMenuProps) {
  const [open, setOpen] = useState(false)
  const [editors, setEditors] = useState<EditorChoice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void api.getEditors(sessionId)
      .then((list) => { if (!cancelled) setEditors(list) })
      .catch(() => { if (!cancelled) setEditors([]) })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const primary = editors.find(item => item.kind === 'editor')

  const launch = (editor?: string) => {
    if (!sessionId || busy) return
    setBusy(true)
    setError(null)
    void api.openWorkspace(sessionId, editor)
      .then(() => setOpen(false))
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="open-in" ref={boxRef}>
      <button
        type="button"
        className={`open-in-btn ${open ? 'active' : ''}`}
        disabled={!sessionId}
        aria-haspopup="menu"
        aria-expanded={open}
        title={workspace ? `在编辑器中打开 ${workspace}` : '在编辑器中打开工作区'}
        onClick={() => setOpen(current => !current)}
      >
        <ExternalLinkIcon size={14} />
        <span className="open-in-label">{primary ? `在 ${primary.name} 中打开` : '在编辑器中打开'}</span>
        <ChevronDownIcon size={11} />
      </button>
      {open
        ? (
          <div className="open-in-menu" role="menu">
            {editors.length
              ? editors.map(editor => (
                <button
                  type="button"
                  role="menuitem"
                  key={editor.id}
                  disabled={busy}
                  onClick={() => launch(editor.id)}
                >
                  <span>{editor.id === 'system' ? '在文件管理器中显示' : `在 ${editor.name} 中打开`}</span>
                  {editor.kind === 'editor' ? <span className="open-in-kind">编辑器</span> : null}
                </button>
              ))
              : <div className="open-in-empty">正在检测本机编辑器…</div>}
            {error ? <div className="open-in-error">{error}</div> : null}
          </div>
        )
        : null}
    </div>
  )
}
