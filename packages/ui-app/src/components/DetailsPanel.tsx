import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type GitInfo } from '../api.ts'
import { modKeyLabel } from '../shortcuts.ts'
import { FileBrowser } from './FileBrowser.tsx'
import { GitPanel } from './GitPanel.tsx'
import { CollapseIcon, CloseIcon, ExpandIcon } from './Icons.tsx'

export type FileView = 'files' | 'git'

interface DetailsPanelProps {
  session: ChatSession | null
  view: FileView
  width: number
  expanded: boolean
  onToggleExpand: () => void
  onResize: (width: number) => void
  onClose: () => void
  /** Insert `@path` for the given file into the composer. */
  onReferenceFile: (path: string) => void
}

const TITLES: Record<FileView, string> = {
  files: '文件',
  git: 'Git',
}

/** File explorer and source control, independent of the session panel. */
export function DetailsPanel({
  session, view, width, expanded, onToggleExpand, onResize, onClose, onReferenceFile,
}: DetailsPanelProps) {
  const [git, setGit] = useState<GitInfo | null>(null)
  const [gitError, setGitError] = useState<string | null>(null)
  const sessionId = session?.id

  const loadGit = useCallback(async (id: string) => {
    try {
      const info = await api.getGitInfo(id)
      setGit(info)
      setGitError(null)
    } catch (caught) {
      setGitError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    if (!sessionId || view !== 'git') {
      setGit(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const info = await api.getGitInfo(sessionId)
        if (cancelled) return
        setGit(info)
        setGitError(null)
      } catch (caught) {
        if (!cancelled) setGitError(caught instanceof Error ? caught.message : String(caught))
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, view])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    document.body.classList.add('resizing')
    const move = (moveEvent: PointerEvent) => onResize(startWidth - (moveEvent.clientX - startX))
    const finish = () => {
      document.body.classList.remove('resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
  }

  return (
    <aside className={`details view-${view}`} style={expanded ? undefined : { width }}>
      {expanded
        ? null
        : (
          <div
            className="details-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整面板宽度"
            onPointerDown={startResize}
            onDoubleClick={() => onResize(344)}
          />
        )}
      <div className="details-head">
        <span className="details-title">{TITLES[view]}</span>
        <div className="details-head-actions">
          <button
            className={`icon-btn subtle ${expanded ? 'active' : ''}`}
            onClick={onToggleExpand}
            aria-label={expanded ? '收起面板' : '展开面板'}
            title={`${expanded ? '收起' : '展开'} (${modKeyLabel()}\\)`}
          >
            {expanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
          </button>
          <button className="icon-btn subtle" onClick={onClose} aria-label={`关闭${TITLES[view]}栏`}>
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className={`details-scroll ${view === 'files' ? 'bare' : ''}`}>
        {session
          ? view === 'files'
            ? <FileBrowser sessionId={session.id} onReference={onReferenceFile} />
            : (
              <>
                {gitError ? <div className="detail-note error">{gitError}</div> : null}
                <GitPanel
                  sessionId={session.id}
                  git={git}
                  onRefresh={() => { void loadGit(session.id) }}
                />
              </>
            )
          : <div className="loading">no session</div>}
      </div>
    </aside>
  )
}
