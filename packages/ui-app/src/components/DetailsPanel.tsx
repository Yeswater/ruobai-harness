import { type PointerEvent as ReactPointerEvent } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { modKeyLabel } from '../shortcuts.ts'
import { FileBrowser } from './FileBrowser.tsx'
import { GitPanel } from './git/GitPanel.tsx'
import { PreviewPane } from './PreviewPane.tsx'
import { TerminalPanel } from './TerminalPanel.tsx'
import { CollapseIcon, CloseIcon, ExpandIcon } from './Icons.tsx'
import { TITLES, type FileView } from '../panel-views.ts'

export type { FileView } from '../panel-views.ts'

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
  onOpenGit: () => void
}

/** File explorer and source control, independent of the session panel. */
export function DetailsPanel({
  session, view, width, expanded, onToggleExpand, onResize, onClose, onReferenceFile,
  openPath, onOpenGit,
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
      {/* The rounded surface is the visible panel; the aside only reserves the
          column and hosts the resizer, so insetting the card does not change the
          width the grid and the drag handle work with. */}
      <div className="details-surface">
      <div className="details-head">
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

      <div className={`details-scroll bare ${view === 'git' ? 'git-scroll' : ''} ${view === 'preview' ? 'preview-scroll' : ''}`}>
        {view === 'terminal'
          ? <TerminalPanel workspace={session?.workspace} />
          : view === 'preview'
          ? <PreviewPane sessionId={session?.id} />
          : session
            ? view === 'files'
              ? <FileBrowser sessionId={session.id} onReference={onReferenceFile} openPath={openPath} />
              : <GitPanel sessionId={session.id} expanded={expanded} />
            : <div className="loading">no session</div>}
      </div>
      </div>
    </aside>
  )
}
