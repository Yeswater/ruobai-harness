import type { ChatSession } from '@ruobai/chat-protocol'
import { SessionPanel } from './SessionPanel.tsx'

interface SessionDockProps {
  session: ChatSession | null
  open: boolean
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
 * sibling of the file browser. The toolbar's 会话信息 button shows or hides it;
 * the block carries no toggle of its own.
 */
export function SessionDock({
  session, open, onOpenContext, onOpenGit, onOpenFile, onOpenSettings, onOpenChanges,
}: SessionDockProps) {
  if (!session || !open) return null

  return (
    <aside className="session-dock open" aria-label="会话信息">
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
    </aside>
  )
}
