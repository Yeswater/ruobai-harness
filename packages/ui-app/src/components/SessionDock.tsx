import type { ChatSession } from '@ruobai/chat-protocol'
import { ChevronLeftIcon, ChevronRightIcon, ListIcon } from './Icons.tsx'
import { SessionPanel } from './SessionPanel.tsx'

interface SessionDockProps {
  session: ChatSession | null
  open: boolean
  onToggle: () => void
  onOpenContext: () => void
  onOpenGit: () => void
  onOpenFile: (path: string) => void
  onOpenSettings: () => void
  onOpenChanges: () => void
}

/**
 * The session summary as its own block beside the conversation.
 *
 * It used to be one more view inside the file panel, which meant it vanished
 * whenever the file panel showed something else — the environment, the context
 * budget and the diff are reference material for the conversation, not a
 * sibling of the file browser. As a dock it keeps its own column, collapses to
 * a rail when the file panel opens (both open at once squeezes the transcript),
 * and comes back with one click.
 */
export function SessionDock({
  session, open, onToggle, onOpenContext, onOpenGit, onOpenFile, onOpenSettings, onOpenChanges,
}: SessionDockProps) {
  if (!session) return null

  return (
    <aside className={`session-dock ${open ? 'open' : 'collapsed'}`} aria-label="会话信息">
      <button
        type="button"
        className="session-dock-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? '收起会话栏' : '展开会话栏'}
        title={open ? '收起会话栏' : '展开会话栏'}
      >
        {open ? <ChevronRightIcon size={13} /> : <ChevronLeftIcon size={13} />}
        {open ? null : <ListIcon size={14} />}
      </button>
      {open
        ? (
          <div className="session-dock-body">
            <SessionPanel
              session={session}
              onOpenContext={onOpenContext}
              onOpenGit={onOpenGit}
              onOpenFile={onOpenFile}
              onOpenSettings={onOpenSettings}
              onOpenChanges={onOpenChanges}
            />
          </div>
        )
        : null}
    </aside>
  )
}
