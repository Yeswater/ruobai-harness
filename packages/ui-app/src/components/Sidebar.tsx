import { useEffect, useState } from 'react'
import type { SessionSummary } from '@ruobai/chat-protocol'
import { GearIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon } from './Icons.tsx'
import { Slot } from './Slot.tsx'

interface SidebarProps {
  sessions: SessionSummary[]
  activeId: string | null
  connected: boolean
  open: boolean
  theme: 'light' | 'dark'
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (id: string, title: string) => void
  onFork: (id: string) => void
  onDelete: (id: string) => void
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
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)

  useEffect(() => {
    if (!menuId) return
    const close = () => setMenuId(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuId])

  const term = query.trim().toLowerCase()
  const filtered = term
    ? props.sessions.filter(session => session.title.toLowerCase().includes(term))
    : props.sessions
  const running = filtered.filter(session => session.streaming)
  const rest = filtered.filter(session => !session.streaming)

  const startRename = (session: SessionSummary) => {
    setMenuId(null)
    setEditingId(session.id)
    setDraft(session.title)
  }

  const finishRename = (session: SessionSummary) => {
    if (editingId !== session.id) return
    setEditingId(null)
    const next = draft.trim()
    if (next && next !== session.title) props.onRename(session.id, next)
  }

  const renderRow = (session: SessionSummary) => (
    <div
      key={session.id}
      className={[
        'session',
        session.id === props.activeId ? 'active' : '',
        session.streaming ? 'running' : '',
      ].filter(Boolean).join(' ')}
    >
      {editingId === session.id ? (
        <input
          className="session-rename"
          value={draft}
          autoFocus
          onFocus={event => event.currentTarget.select()}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              finishRename(session)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setEditingId(null)
            }
          }}
          onBlur={() => finishRename(session)}
        />
      ) : (
        <button
          className="session-open"
          onClick={() => props.onSelect(session.id)}
          onDoubleClick={() => startRename(session)}
        >
          <span className="session-title">{session.title}</span>
          <span className="session-meta">
            {session.streaming ? (
              <>
                <span className="pulse" aria-label="running" />
                <span className="session-running">running</span>
                <span className="meta-dot">·</span>
                <span>{session.messageCount}</span>
              </>
            ) : (
              <>
                <span>{relativeTime(session.updatedAt)}</span>
                <span className="meta-dot">·</span>
                <span>{session.messageCount}</span>
              </>
            )}
          </span>
        </button>
      )}

      {editingId === session.id ? null : (
        <button
          className="session-more"
          aria-label="Session actions"
          onClick={(event) => {
            event.stopPropagation()
            setMenuId(current => current === session.id ? null : session.id)
          }}
        >
          ⋯
        </button>
      )}

      {menuId === session.id ? (
        <div className="session-menu" onClick={event => event.stopPropagation()}>
          <button onClick={() => startRename(session)}>Rename</button>
          <button disabled={session.streaming} onClick={() => { setMenuId(null); props.onFork(session.id) }}>Fork</button>
          <button className="danger" onClick={() => { setMenuId(null); setPendingDelete(session) }}>Delete</button>
        </div>
      ) : null}
    </div>
  )

  return (
    <>
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

        <div className="session-search">
          <SearchIcon size={13} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder="Search sessions"
            aria-label="Search sessions"
          />
          {query ? <button onClick={() => setQuery('')} aria-label="Clear search">×</button> : null}
        </div>

        <div className="session-list">
          {running.length ? (
            <>
              <div className="list-label">
                <span>Running</span>
                <span className="list-count">{running.length}</span>
              </div>
              {running.map(renderRow)}
            </>
          ) : null}

          <div className="list-label">
            <span>{term ? 'Results' : 'Sessions'}</span>
            <span className="list-count">{rest.length}</span>
          </div>
          {rest.map(renderRow)}

          {filtered.length ? null : (
            <div className="list-empty">
              {term ? `No sessions match “${query.trim()}”` : 'No sessions yet'}
            </div>
          )}
        </div>

        <div className="sidebar-foot">
          <span className={`status-dot ${props.connected ? 'ok' : 'off'}`} />
          <span>{props.connected ? 'connected' : 'reconnecting'}</span>
          <span className="meta-dot">·</span>
          <span className="foot-plain">ruobai-chat</span>
          <Slot name="sidebar.footer" />
        </div>
      </aside>

      {pendingDelete ? (
        <div className="modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="modal confirm-modal" onClick={event => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Delete session</h2>
            </div>
            <div className="modal-body">
              <p className="modal-note">
                “{pendingDelete.title}” and its full event log will be removed. This cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <span className="hint">{pendingDelete.messageCount} messages</span>
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setPendingDelete(null)}>Cancel</button>
                <button
                  className="btn danger-solid"
                  onClick={() => {
                    const target = pendingDelete
                    setPendingDelete(null)
                    props.onDelete(target.id)
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
