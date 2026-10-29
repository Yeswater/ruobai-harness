import { useEffect, useRef, useState } from 'react'
import { api, type EditorChoice } from '../api.ts'
import { ChevronDownIcon } from './Icons.tsx'
import { EditorIcon } from './EditorIcon.tsx'

interface OpenInMenuProps {
  sessionId?: string
  workspace?: string
}

/**
 * "Open in editor" as a split button: the tile is the editor's own mark, so the
 * action reads as an icon in the toolbar instead of a sentence, and the arrow
 * opens the full list.
 *
 * The default is the first detected editor — the one the user actually has —
 * and the menu labels it, because a tile alone cannot say which app it is.
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

  const primary = editors.find(item => item.kind === 'editor') ?? editors[0]
  const disabled = !sessionId || busy

  const launch = (editor?: string) => {
    if (!sessionId || busy) return
    setBusy(true)
    setError(null)
    void api.openWorkspace(sessionId, editor)
      .then(() => setOpen(false))
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false))
  }

  const title = primary
    ? `在 ${primary.name} 中打开${workspace ? `：${workspace}` : ''}`
    : '在编辑器中打开工作区'

  return (
    <div className="open-in" ref={boxRef}>
      <button
        type="button"
        className="open-in-go"
        disabled={disabled || !primary}
        title={title}
        aria-label={title}
        onClick={() => launch(primary?.id)}
      >
        <EditorIcon id={primary?.id ?? 'fallback'} name={primary?.name} size={17} />
      </button>
      <button
        type="button"
        className={`open-in-more ${open ? 'active' : ''}`}
        disabled={!sessionId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="选择打开方式"
        title="选择打开方式"
        onClick={() => setOpen(current => !current)}
      >
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
                  <EditorIcon id={editor.id} name={editor.name} size={18} />
                  <span className="open-in-name">{editor.name}</span>
                  {/* The reference marks the default inline; a tile alone cannot
                      say which app the left half will launch. */}
                  {editor.id === primary?.id ? <span className="open-in-default">（默认）</span> : null}
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
