import type { SessionSummary } from '@ruobai/chat-protocol'
import { GearIcon, MoonIcon, PlusIcon, SunIcon } from './Icons.tsx'
import { Slot } from './Slot.tsx'

interface SidebarProps {
  sessions: SessionSummary[]
  activeId: string | null
  connected: boolean
  open: boolean
  theme: 'light' | 'dark'
  onSelect: (id: string) => void
  onCreate: () => void
  onToggleTheme: () => void
  onOpenSettings: () => void
}

export function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className={`sidebar ${props.open ? 'open' : ''}`}>
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div className="brand-text">
            <span className="brand-name">ruobai</span>
            <span className="brand-sub">harness</span>
          </div>
        </div>
        <div className="sidebar-actions">
          <button className="icon-btn subtle" onClick={props.onOpenSettings} aria-label="Settings">
            <GearIcon />
          </button>
          <button className="icon-btn subtle" onClick={props.onToggleTheme} aria-label="Toggle theme">
            {props.theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </div>

      <button className="new-session" onClick={props.onCreate}>
        <PlusIcon size={15} />
        <span>New session</span>
        <span className="kbd">⌘N</span>
      </button>

      <div className="session-list">
        <div className="list-label">Sessions</div>
        {props.sessions.map((session) => (
          <button
            key={session.id}
            className={`session ${session.id === props.activeId ? 'active' : ''}`}
            onClick={() => props.onSelect(session.id)}
          >
            <span className="session-title">{session.title}</span>
            <span className="session-meta">
              <span>{relativeTime(session.updatedAt)}</span>
              <span className="meta-dot">·</span>
              <span>{session.messageCount}</span>
              {session.streaming ? <span className="pulse" aria-label="streaming" /> : null}
            </span>
          </button>
        ))}
      </div>

      <div className="sidebar-foot">
        <span className={`status-dot ${props.connected ? 'ok' : 'off'}`} />
        <span>{props.connected ? 'connected' : 'reconnecting'}</span>
        <span className="meta-dot">·</span>
        <span className="foot-plain">ruobai-chat</span>
        <Slot name="sidebar.footer" />
      </div>
    </aside>
  )
}
