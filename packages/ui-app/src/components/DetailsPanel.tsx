import { type PointerEvent as ReactPointerEvent } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { modKeyLabel } from '../shortcuts.ts'
import { FileBrowser } from './FileBrowser.tsx'
import { GitPanel } from './git/GitPanel.tsx'
import { PreviewPane } from './PreviewPane.tsx'
import { SessionPanel } from './SessionPanel.tsx'
import { CollapseIcon, CloseIcon, ExpandIcon } from './Icons.tsx'

export type FileView = 'files' | 'git' | 'preview' | 'session'

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
  /** Open this file once per token when the file browser mounts/updates. */
  openPath?: { path: string; token: number }
  onOpenContext: () => void
  onOpenGit: () => void
  onOpenFile: (path: string) => void
  onOpenSettings: () => void
  onOpenChanges: () => void
}

const TITLES: Record<FileView, string> = {
  files: '文件',
  git: 'Git',
  preview: '预览',
  session: '会话',
}

/** File explorer and source control, independent of the session panel. */
export function DetailsPanel({
  session, view, width, expanded, onToggleExpand, onResize, onClose, onReferenceFile,
  openPath, onOpenContext, onOpenGit, onOpenFile, onOpenSettings, onOpenChanges,
}: DetailsPanelProps) {
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

      <div className={`details-scroll bare ${view === 'git' ? 'git-scroll' : ''} ${view === 'preview' ? 'preview-scroll' : ''} ${view === 'session' ? 'session-scroll' : ''}`}>
        {view === 'preview'
          ? <PreviewPane />
          : view === 'session'
            ? (
              <SessionPanel
                session={session}
                onOpenContext={onOpenContext}
                onOpenGit={onOpenGit}
                onOpenFile={onOpenFile}
                onOpenSettings={onOpenSettings}
                onOpenChanges={onOpenChanges}
              />
            )
            : session
              ? view === 'files'
                ? <FileBrowser sessionId={session.id} onReference={onReferenceFile} openPath={openPath} />
                : <GitPanel sessionId={session.id} expanded={expanded} />
              : <div className="loading">no session</div>}
      </div>
    </aside>
  )
}
