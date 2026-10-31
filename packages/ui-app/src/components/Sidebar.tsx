import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@ruobai/chat-protocol'
import {
  ancestorKeys, DEFAULT_VIEW, filterSessions, FLAT_KEY, groupSessions, moveSession,
  UNGROUPED_KEY, type ManualOrder, type SidebarView,
} from '../sidebar-model.ts'
import type { FunctionView } from '../function-views.ts'
import { FUNCTION_VIEWS } from '../function-views.ts'
import {
  BrandMarkIcon, ChevronRightIcon, FolderIcon, FolderPlusIcon, FolderTreeIcon, GearIcon,
  PanelLeftIcon, PlusIcon, SearchIcon, SparkIcon,
} from './Icons.tsx'
import { isDraftId } from '../draft-session.ts'
import { BalanceCard } from './BalanceCard.tsx'
import { useContextMenu } from './ContextMenu.tsx'
import { SidebarViewMenu } from './SidebarViewMenu.tsx'
import { useShortcutLabel } from '../useShortcuts.ts'
import type { CollapsedSidebar } from '../preferences.ts'

interface SidebarProps {
  sessions: SessionSummary[]
  activeId: string | null
  open: boolean
  collapsed: boolean
  /** What the collapsed sidebar leaves behind: nothing, or an icon rail. */
  collapsedMode: CollapsedSidebar
  /** Hides the brand block; the new-session button stays. */
  showBrand: boolean
  onToggleCollapse: () => void
  onSelect: (id: string) => void
  onCreate: () => void
  /** Opens the folder picker: the sidebar's "add workspace" action. */
  onAddWorkspace: () => void
  onCreateIn: (workspace?: string) => void
  onRename: (id: string, title: string) => void
  onFork: (id: string) => void
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  /** Opens the 模型 tab directly (the balance card's footer link). */
  onOpenModelSettings: () => void
  functionView: FunctionView | null
  onOpenFunction: (view: FunctionView) => void
  /** Current width in px; the resizer reports a new one while dragging. */
  width?: number
  onResize?: (width: number) => void
}

interface DragState {
  key: string
  id: string
  targetId?: string
  half?: 'before' | 'after'
}

const VIEW_KEY = 'rbh-sidebar-view'
const ORDER_KEY = 'rbh-sidebar-order'
/** Folded workspace/folder keys. Never the shell's own collapse key. */
const FOLDED_KEY = 'rbh-sidebar-folded'
/** Sessions shown before the group's "show more" row. */
const GROUP_LIMIT = 5

function loadView(): SidebarView {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (!raw) return DEFAULT_VIEW
    const saved = JSON.parse(raw) as Partial<SidebarView>
    return {
      groupBy: saved.groupBy === 'tree' || saved.groupBy === 'flat' ? saved.groupBy : 'workspace',
      orderBy: saved.orderBy === 'manual' ? 'manual' : 'updated',
      filter: saved.filter === 'all' || saved.filter === 'archived' ? saved.filter : 'active',
    }
  } catch {
    return DEFAULT_VIEW
  }
}

function loadOrders(): ManualOrder {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    return raw ? JSON.parse(raw) as ManualOrder : {}
  } catch {
    return {}
  }
}

function loadFolded(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLDED_KEY)
    return new Set(raw ? JSON.parse(raw) as string[] : [])
  } catch {
    return new Set()
  }
}

export function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}个月`
  return `${Math.floor(months / 12)}年`
}

function functionIcon(id: FunctionView) {
  return id === 'wiki' ? <FolderTreeIcon size={15} /> : <SparkIcon size={15} />
}

export function Sidebar(props: SidebarProps) {
  const contextMenu = useContextMenu()
  const newSessionKey = useShortcutLabel('new-session')
  const settingsKey = useShortcutLabel('settings')
  const [view, setView] = useState<SidebarView>(loadView)
  const [orders, setOrders] = useState<ManualOrder>(loadOrders)
  const [folded, setFolded] = useState<Set<string>>(loadFolded)
  const [revealed, setRevealed] = useState<Record<string, number>>({})
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dropCommitted = useRef(false)

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view))
  }, [view])

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

  const filtered = useMemo(
    () => filterSessions(props.sessions, view.filter, query),
    [props.sessions, view.filter, query],
  )
  const groups = useMemo(
    () => groupSessions(filtered, view, orders),
    [filtered, view, orders],
  )

  const saveOrders = (next: ManualOrder) => {
    setOrders(next)
    localStorage.setItem(ORDER_KEY, JSON.stringify(next))
  }

  const searching = query.trim().length > 0
  // Each workspace folds on its own: opening one never closes another.
  const isFolded = (group: { key: string }) => {
    if (searching) return false
    return folded.has(group.key)
  }

  const toggleGroup = (key: string) => {
    setFolded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]))
      return next
    })
    // Re-opening starts from the first page of sessions again.
    setRevealed(previous => ({ ...previous, [key]: GROUP_LIMIT }))
  }

  const revealMore = (key: string) => {
    setRevealed(previous => ({ ...previous, [key]: (previous[key] ?? GROUP_LIMIT) + GROUP_LIMIT }))
  }

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

  const commitDrag = (key: string, source: string, target: string, half: 'before' | 'after') => {
    const shown = groups.find(item => item.key === key)
    if (!shown) return
    const ids = shown.sessions.map(session => session.id)
    if (!ids.includes(source) || !ids.includes(target)) return
    saveOrders({ ...orders, [key]: moveSession(ids, source, target, half) })
  }

  const createIn = (group: { key: string; canCreate: boolean }) => {
    if (!group.canCreate) return
    if (isFolded(group)) toggleGroup(group.key)
    props.onCreateIn(group.key === UNGROUPED_KEY ? undefined : group.key)
  }

  const renderRow = (session: SessionSummary, groupKey: string, indent: number) => {
    // An unsent session has no host log yet: it can be opened, but there is
    // nothing to rename, fork, archive or delete until its first message.
    const draftRow = isDraftId(session.id)
    const draggable = view.orderBy === 'manual' && !draftRow
    const active = drag?.key === groupKey && drag.id === session.id
    const marker = drag?.key === groupKey && drag.targetId === session.id ? drag.half : undefined

    return (
      <div
        key={session.id}
        className={[
          'session',
          session.id === props.activeId ? 'active' : '',
          session.streaming ? 'running' : '',
          session.archived ? 'archived' : '',
          active ? 'dragging' : '',
          marker === 'before' ? 'drop-before' : '',
          marker === 'after' ? 'drop-after' : '',
        ].filter(Boolean).join(' ')}
        style={{ marginLeft: indent }}
        draggable={draggable && editingId !== session.id}
        onContextMenu={(event) => {
          if (editingId === session.id || draftRow) return
          setMenuId(null)
          contextMenu.open(event, [
            { label: '重命名', onSelect: () => startRename(session) },
            {
              label: '分叉',
              disabled: session.streaming,
              onSelect: () => props.onFork(session.id),
            },
            {
              label: session.archived ? '取消归档' : '归档会话',
              onSelect: () => props.onArchive(session.id, !session.archived),
            },
            { separator: true },
            {
              label: '删除',
              danger: true,
              onSelect: () => setPendingDelete(session),
            },
          ])
        }}
        onDragStart={(event) => {
          if (!draggable) return
          dropCommitted.current = false
          event.dataTransfer.effectAllowed = 'move'
          setDrag({ key: groupKey, id: session.id })
        }}
        onDragOver={(event) => {
          if (!drag || drag.key !== groupKey || draftRow) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          const rect = event.currentTarget.getBoundingClientRect()
          const half = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
          if (drag.targetId !== session.id || drag.half !== half) {
            setDrag({ ...drag, targetId: session.id, half })
          }
        }}
        onDrop={(event) => {
          if (!drag || drag.key !== groupKey || draftRow) return
          event.preventDefault()
          dropCommitted.current = true
          const rect = event.currentTarget.getBoundingClientRect()
          const half = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
          commitDrag(groupKey, drag.id, session.id, half)
          setDrag(null)
        }}
        onDragEnd={() => {
          if (!dropCommitted.current && drag?.targetId) {
            commitDrag(groupKey, drag.id, drag.targetId, drag.half ?? 'after')
          }
          setDrag(null)
        }}
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
            onDoubleClick={() => { if (!draftRow) startRename(session) }}
          >
            <span className="session-title">{session.title || '新的会话'}</span>
            <span className="session-meta">
              {session.streaming
                ? <span className="pulse" aria-label="running" />
                : null}
              {draftRow
                ? <span className="session-tag draft">草稿</span>
                : session.archived ? <span className="session-tag">已归档</span> : null}
              {draftRow
                ? null
                : <span className="session-time">{session.streaming ? '运行中' : relativeTime(session.updatedAt)}</span>}
            </span>
          </button>
        )}

        {editingId === session.id || draftRow ? null : (
          <button
            className="session-more"
            aria-label="会话操作"
            onClick={(event) => {
              event.stopPropagation()
              setMenuId(current => current === session.id ? null : session.id)
            }}
          >
            ⋯
          </button>
        )}

        {menuId === session.id && !draftRow ? (
          <div className="session-menu" onClick={event => event.stopPropagation()}>
            <button onClick={() => startRename(session)}>重命名</button>
            <button disabled={session.streaming} onClick={() => { setMenuId(null); props.onFork(session.id) }}>分叉</button>
            <button onClick={() => {
              setMenuId(null)
              props.onArchive(session.id, !session.archived)
            }}>
              {session.archived ? '取消归档' : '归档会话'}
            </button>
            <button className="danger" onClick={() => { setMenuId(null); setPendingDelete(session) }}>删除</button>
          </div>
        ) : null}
      </div>
    )
  }

  const renderGroup = (group: typeof groups[number]) => {
    if (group.key === FLAT_KEY) {
      return (
        <div key={FLAT_KEY} className="ws-group">
          {group.sessions.map(session => renderRow(session, group.key, 0))}
        </div>
      )
    }
    const folded = isFolded(group)
    const current = group.sessions.some(session => session.id === props.activeId)
    // An open workspace shows a page at a time; search results are never cut.
    const limit = searching ? group.sessions.length : revealed[group.key] ?? GROUP_LIMIT
    const shown = group.sessions.slice(0, limit)
    const hidden = group.sessions.length - shown.length
    return (
      <div key={group.key || '__ungrouped'} className="ws-group">
        <div
          className={`ws-head ${current ? 'current' : ''}`}
          style={{ paddingLeft: 4 + group.depth * 14 }}
        >
          <button
            className="ws-toggle"
            onClick={() => toggleGroup(group.key)}
            aria-expanded={!folded}
            title={group.path ?? group.label}
          >
            <span className={`ws-chevron ${folded ? '' : 'open'}`}>
              <ChevronRightIcon size={12} />
            </span>
            <span className="ws-folder"><FolderIcon size={15} /></span>
            <span className="ws-label">{group.label}</span>
          </button>
          {group.canCreate ? <span className="ws-count">{group.sessions.length}</span> : null}
          {group.canCreate ? (
            <button
              className="ws-add"
              aria-label={`在 ${group.label} 中新建会话`}
              onClick={() => createIn(group)}
            >
              <PlusIcon size={12} />
            </button>
          ) : null}
        </div>
        {folded
          ? null
          : (
            <>
              {shown.map(session => renderRow(session, group.key, 14 + group.depth * 14))}
              {hidden > 0
                ? (
                  <button className="ws-more" onClick={() => revealMore(group.key)}>
                    显示更多（还有 {hidden} 条）
                  </button>
                )
                : null}
            </>
          )}
      </div>
    )
  }

  const collapsedAncestor = (group: typeof groups[number]) =>
    ancestorKeys(group.path).some(key => isFolded({ key }))
  const visibleGroups = view.groupBy === 'tree'
    ? groups.filter(group => !collapsedAncestor(group))
    : groups

  // Collapsed with an icon rail: the column stays, only clickable entries do.
  // `open` is the narrow-screen overlay; there the full sidebar still wins.
  if (props.collapsed && props.collapsedMode === 'rail' && !props.open) {
    return (
      <aside className="sidebar rail">
        <div className="rail-top">
          {props.showBrand
            ? (
              <button
                type="button"
                className="rail-btn rail-brand"
                onClick={props.onCreate}
                title={`新会话 (${newSessionKey})`}
                aria-label="新会话"
              >
                <BrandMarkIcon size={22} />
              </button>
            )
            : null}
          <button
            type="button"
            className="rail-btn"
            onClick={props.onCreate}
            title={`新会话 (${newSessionKey})`}
            aria-label="新会话"
          >
            <PlusIcon size={17} />
          </button>
        </div>

        <nav className="rail-nav" aria-label="功能">
          {FUNCTION_VIEWS.map(item => (
            <button
              key={item.id}
              type="button"
              className={`rail-btn ${props.functionView === item.id ? 'active' : ''}`}
              onClick={() => props.onOpenFunction(item.id)}
              title={item.label}
              aria-label={item.label}
            >
              {functionIcon(item.id)}
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <button
            type="button"
            className="rail-btn"
            onClick={props.onToggleCollapse}
            title="展开工作区栏"
            aria-label="展开工作区栏"
          >
            <PanelLeftIcon />
          </button>
          <button
            type="button"
            className="rail-btn"
            onClick={props.onOpenSettings}
            title={`打开设置 (${settingsKey})`}
            aria-label="打开设置"
          >
            <GearIcon />
          </button>
        </div>
      </aside>
    )
  }

  return (
    <>
      <aside className={`sidebar ${props.open ? 'open' : ''}`}>
        {props.onResize
          ? (
            <div
              className="sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧栏宽度"
              onPointerDown={(event) => {
                event.preventDefault()
                const startX = event.clientX
                const startWidth = props.width ?? 272
                document.body.classList.add('resizing')
                const move = (moveEvent: PointerEvent) =>
                  props.onResize?.(startWidth + (moveEvent.clientX - startX))
                const finish = () => {
                  document.body.classList.remove('resizing')
                  window.removeEventListener('pointermove', move)
                  window.removeEventListener('pointerup', finish)
                }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', finish)
              }}
              onDoubleClick={() => props.onResize?.(272)}
            />
          )
          : null}
        <div className="sidebar-head">
          {/* The collapse button lives with the brand: turning the brand off
              also removes the row (⌘B still toggles the sidebar). */}
          {props.showBrand
            ? (
              <div className="sidebar-brand-row">
                <button
                  type="button"
                  className="brand"
                  onClick={props.onCreate}
                  title={`新会话 (${newSessionKey})`}
                >
                  <span className="brand-mark" aria-hidden="true"><BrandMarkIcon /></span>
                  <span className="brand-text">
                    <span className="brand-name">RuoBai</span>
                    <span className="brand-badge">HARNESS</span>
                  </span>
                </button>
                <button
                  className="icon-btn subtle sidebar-collapse"
                  onClick={props.onToggleCollapse}
                  aria-label={props.collapsed ? '展开工作区栏' : '收起工作区栏'}
                  title={props.collapsed ? '展开工作区栏' : '收起工作区栏'}
                >
                  <PanelLeftIcon />
                </button>
              </div>
            )
            : null}
          <button
            type="button"
            className="sidebar-new"
            onClick={props.onCreate}
            title={`新会话 (${newSessionKey})`}
          >
            <PlusIcon size={14} />
            <span>新会话</span>
          </button>
        </div>

        <nav className="function-rail" aria-label="功能">
          {FUNCTION_VIEWS.map(item => (
            <button
              key={item.id}
              type="button"
              className={`function-item ${props.functionView === item.id ? 'active' : ''}`}
              onClick={() => props.onOpenFunction(item.id)}
              aria-current={props.functionView === item.id ? 'page' : undefined}
              title={item.description}
            >
              <span className="function-icon">{functionIcon(item.id)}</span>
              <span className="function-label">{item.label}</span>
              {item.badge ? <span className="function-badge">{item.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-workspace-head">
          {searchOpen
            ? (
              <div className="session-search inline">
                <SearchIcon size={13} />
                <input
                  value={query}
                  autoFocus
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setQuery('')
                      setSearchOpen(false)
                    }
                  }}
                  placeholder="搜索会话…"
                  aria-label="搜索会话"
                />
                <button
                  onClick={() => {
                    setQuery('')
                    setSearchOpen(false)
                  }}
                  aria-label="关闭搜索"
                >
                  ×
                </button>
              </div>
            )
            : (
              <div className="sidebar-title-row">
                <h2 className="workspace-title">工作区</h2>
                <div className="workspace-actions">
                  <button className="icon-btn subtle" onClick={() => setSearchOpen(true)} aria-label="搜索会话">
                    <SearchIcon />
                  </button>
                  <SidebarViewMenu
                    view={view}
                    onChange={patch => setView(current => ({ ...current, ...patch }))}
                  />
                  <button className="icon-btn subtle" onClick={props.onAddWorkspace} aria-label="添加工作区">
                    <FolderPlusIcon />
                  </button>
                </div>
              </div>
            )}
        </div>

        <div className={`session-list ${drag ? 'dragging' : ''}`}>
          {visibleGroups.map(renderGroup)}

          {filtered.length ? null : (
            <div className="list-empty">
              {query
                ? `没有匹配“${query.trim()}”的会话`
                : view.filter === 'archived'
                  ? '还没有归档的会话'
                  : props.sessions.length
                    ? '没有未归档的会话'
                    : '还没有会话，点击「新会话」开始'}
            </div>
          )}
        </div>

        <BalanceCard onOpenModelSettings={props.onOpenModelSettings} />

        <button
          type="button"
          className="sidebar-foot"
          onClick={props.onOpenSettings}
          aria-label="打开设置"
          title={`打开设置 (${settingsKey})`}
        >
          <GearIcon size={15} />
          <span>设置</span>
        </button>
      </aside>

      {pendingDelete ? (
        <div className="modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="modal confirm-modal" onClick={event => event.stopPropagation()}>
            <div className="modal-head">
              <h2>删除会话</h2>
            </div>
            <div className="modal-body">
              <p className="modal-note">
                “{pendingDelete.title}”及其完整事件日志都会被删除，此操作无法撤销。
              </p>
            </div>
            <div className="modal-foot">
              <span className="hint">{pendingDelete.messageCount} 条消息</span>
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setPendingDelete(null)}>取消</button>
                <button
                  className="btn danger-solid"
                  onClick={() => {
                    const target = pendingDelete
                    setPendingDelete(null)
                    props.onDelete(target.id)
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
