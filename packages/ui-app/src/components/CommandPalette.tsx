import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SessionSummary } from '@ruobai/chat-protocol'
import {
  buildPaletteGroups, flattenEntries,
  type PaletteCommand, type PaletteEntry, type PaletteGroup,
} from '../command-palette-model.ts'
import { shortcutLabel } from '../shortcuts.ts'
import { useShortcutLabel } from '../useShortcuts.ts'
import { useEscapeKey } from '../useEscapeKey.ts'
import { ChatIcon, CommandIcon, SearchIcon } from './Icons.tsx'
import { relativeTime } from './Sidebar.tsx'

interface CommandPaletteProps {
  open: boolean
  sessions: SessionSummary[]
  commands: PaletteCommand[]
  onClose: () => void
  onSelectSession: (id: string) => void
  onRunCommand: (id: string) => void
}

/** Wraps the first query term hit in the label so the match is obvious. */
function highlight(label: string, query: string) {
  const term = query.trim().split(/\s+/)[0]?.toLowerCase()
  if (!term) return label
  const index = label.toLowerCase().indexOf(term)
  if (index === -1) return label
  return (
    <>
      {label.slice(0, index)}
      <mark>{label.slice(index, index + term.length)}</mark>
      {label.slice(index + term.length)}
    </>
  )
}

function groupIcon(group: PaletteGroup) {
  return group.key === 'sessions' ? <ChatIcon size={15} /> : <CommandIcon size={15} />
}

export function CommandPalette(props: CommandPaletteProps) {
  const paletteKey = useShortcutLabel('palette')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEscapeKey(props.onClose, props.open)

  useEffect(() => {
    if (!props.open) return
    setQuery('')
    setActive(0)
    // Focusing after the paint keeps iOS from scrolling the page behind it.
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [props.open])

  const groups = useMemo(
    () => buildPaletteGroups({
      sessions: props.sessions,
      commands: props.commands,
      query,
      formatTime: relativeTime,
    }),
    [props.sessions, props.commands, query],
  )
  const entries = useMemo(() => flattenEntries(groups), [groups])
  const indexOf = useMemo(
    () => new Map(entries.map((entry, index) => [entry.id, index])),
    [entries],
  )
  const clamped = entries.length ? Math.min(active, entries.length - 1) : 0

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.palette-row.active')
    row?.scrollIntoView({ block: 'nearest' })
  }, [clamped, entries.length])

  if (!props.open) return null

  const pick = (entry: PaletteEntry | undefined) => {
    if (!entry) return
    props.onClose()
    if (entry.sessionId) props.onSelectSession(entry.sessionId)
    else if (entry.commandId) props.onRunCommand(entry.commandId)
  }

  const move = (delta: number) => {
    if (!entries.length) return
    setActive((current) => {
      const next = (Math.min(current, entries.length - 1) + delta) % entries.length
      return next < 0 ? next + entries.length : next
    })
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Home' || (event.key === 'PageUp' && !event.metaKey && !event.ctrlKey)) {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End' || (event.key === 'PageDown' && !event.metaKey && !event.ctrlKey)) {
      event.preventDefault()
      setActive(Math.max(0, entries.length - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(entries[clamped])
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={props.onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-search">
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder="搜索会话或命令…"
            role="combobox"
            aria-label="全局搜索"
            aria-expanded
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={entries[clamped] ? `palette-${entries[clamped]!.id}` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          {query
            ? (
              <button
                className="palette-clear"
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  setQuery('')
                  setActive(0)
                  inputRef.current?.focus()
                }}
                aria-label="清除搜索"
              >
                ×
              </button>
            )
            : <span className="keycap">{paletteKey}</span>}
        </div>

        <div className="palette-list" id="palette-list" role="listbox" aria-label="搜索结果" ref={listRef}>
          {entries.length
            ? groups.map(group => (
              <div className="palette-group" key={group.key} role="group" aria-label={group.title}>
                <div className="palette-group-title">{group.title}</div>
                {group.entries.map((entry) => {
                  const index = indexOf.get(entry.id) ?? 0
                  return (
                    <button
                      key={entry.id}
                      id={`palette-${entry.id}`}
                      type="button"
                      role="option"
                      aria-selected={index === clamped}
                      className={`palette-row ${index === clamped ? 'active' : ''}`}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(entry)}
                    >
                      <span className="palette-row-icon">{groupIcon(group)}</span>
                      <span className="palette-row-text">
                        <span className="palette-row-label">{highlight(entry.label, query)}</span>
                        {entry.description
                          ? <span className="palette-row-desc">{entry.description}</span>
                          : null}
                      </span>
                      {entry.meta ? <span className="palette-row-meta">{entry.meta}</span> : null}
                      {entry.shortcut
                        ? <span className="keycap">{shortcutLabel(entry.shortcut)}</span>
                        : null}
                    </button>
                  )
                })}
              </div>
            ))
            : <div className="palette-empty">没有匹配的结果</div>}
        </div>

        <div className="palette-foot">
          <span><span className="keycap">↑</span><span className="keycap">↓</span> 选择</span>
          <span><span className="keycap">↵</span> 打开</span>
          <span><span className="keycap">esc</span> 关闭</span>
        </div>
      </div>
    </div>
  )
}
