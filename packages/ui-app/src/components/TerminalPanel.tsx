import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { api, type TerminalInfo } from '../api.ts'
import { terminalBus } from '../panel-events.ts'
import { CloseIcon, CollapseIcon, ExpandIcon, PlusIcon, TrashIcon } from './Icons.tsx'

interface TerminalPanelProps {
  workspace?: string
  onClose: () => void
}

interface Instance {
  term: Terminal
  fit: FitAddon
  element: HTMLDivElement
  replaying: boolean
  pending: string[]
  input: string
  flush?: number
}

const FONT = '"SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

/**
 * Bottom terminal dock.
 *
 * The shell lives on the server (a pty behind `/api/terminal`); this component
 * only renders bytes and sends keystrokes. Buffers replay from the server, so
 * closing and reopening the dock keeps the scrollback.
 */
export function TerminalPanel({ workspace, onClose }: TerminalPanelProps) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const instances = useRef(new Map<string, Instance>())
  const bodyRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<string | null>(null)
  const bootstrapped = useRef<Promise<void> | null>(null)

  useEffect(() => {
    activeRef.current = activeId
  }, [activeId])

  const attach = useCallback((id: string, element: HTMLDivElement | null) => {
    if (!element) return
    const existing = instances.current.get(id)
    if (existing) {
      if (existing.element !== element) existing.fit.fit()
      return
    }

    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: FONT,
      cursorBlink: true,
      scrollback: 5_000,
      theme: themeOf(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    const instance: Instance = { term, fit, element, replaying: true, pending: [], input: '' }
    instances.current.set(id, instance)
    try {
      fit.fit()
    } catch {
      // The dock may still be measuring; the observer fits again.
    }

    term.onData((data) => {
      instance.input += data
      if (instance.flush !== undefined) return
      instance.flush = window.setTimeout(() => {
        instance.flush = undefined
        const payload = instance.input
        instance.input = ''
        if (!payload) return
        // The server rejects writes above 64 KiB; split a large paste.
        for (let offset = 0; offset < payload.length; offset += 32_768) {
          void api.writeTerminal(id, payload.slice(offset, offset + 32_768)).catch(() => undefined)
        }
      }, 8)
    })
    term.onResize(({ cols, rows }) => {
      void api.resizeTerminal(id, cols, rows).catch(() => undefined)
    })

    void api.terminalBuffer(id)
      .then((buffer) => {
        if (buffer) term.write(buffer)
      })
      .catch(() => undefined)
      .finally(() => {
        instance.replaying = false
        for (const chunk of instance.pending) term.write(chunk)
        instance.pending = []
      })
  }, [])

  // Load existing shells once; a fresh dock gets one terminal.
  //
  // StrictMode runs effects twice. Starting the request once and sharing its
  // promise prevents a second shell from being spawned; the result is applied
  // through an idempotent upsert, so a late `changed` frame cannot duplicate
  // the tab either.
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = (async () => {
      try {
        const list = await api.listTerminals()
        if (list.length) {
          setTerminals(list)
          setActiveId(current => current ?? list[0]!.id)
          return
        }
        const created = await api.createTerminal({ cwd: workspace, cols: 100, rows: 30 })
        setTerminals(current => upsert(current, created))
        setActiveId(current => current ?? created.id)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }, [])

  useEffect(() => {
    return terminalBus.subscribe((event) => {
      if (event.kind === 'changed') {
        setTerminals(current => merge(current, event.terminals))
        return
      }
      const instance = instances.current.get(event.id)
      if (event.kind === 'output') {
        if (!instance) return
        if (instance.replaying) instance.pending.push(event.data)
        else instance.term.write(event.data)
        return
      }
      instance?.term.write(`\r\n[进程已退出${event.code !== null ? ` (${event.code})` : ''}]\r\n`)
      setTerminals(list => list.map(item =>
        item.id === event.id ? { ...item, alive: false, exitCode: event.code } : item,
      ))
    })
  }, [])

  // Theme changes must reach already-open terminals.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      for (const instance of instances.current.values()) instance.term.options.theme = themeOf()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const host = bodyRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const instance = activeRef.current ? instances.current.get(activeRef.current) : undefined
      try {
        instance?.fit.fit()
      } catch {
        // hidden or zero-sized
      }
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const instance = activeId ? instances.current.get(activeId) : undefined
      try {
        instance?.fit.fit()
      } catch {
        // not laid out yet
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [activeId, expanded])

  useEffect(() => () => {
    for (const instance of instances.current.values()) instance.term.dispose()
    instances.current.clear()
  }, [])

  const create = async () => {
    setError(null)
    try {
      const terminal = await api.createTerminal({ cwd: workspace, cols: 100, rows: 30 })
      setTerminals(list => upsert(list, terminal))
      setActiveId(terminal.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const closeTerminal = async (id: string) => {
    instances.current.get(id)?.term.dispose()
    instances.current.delete(id)
    // Compute the next list outside the state updater: StrictMode calls
    // updaters twice, and the active-tab switch is a side effect.
    const remaining = terminals.filter(item => item.id !== id)
    setTerminals(remaining)
    if (activeId === id) setActiveId(remaining.at(-1)?.id ?? null)
    await api.deleteTerminal(id).catch(() => undefined)
  }

  const clearActive = () => {
    if (activeId) instances.current.get(activeId)?.term.clear()
  }

  return (
    <section className={`terminal-dock ${expanded ? 'expanded' : ''}`} aria-label="终端">
      <div className="terminal-head">
        <div className="terminal-tabs" role="tablist">
          {terminals.map(item => (
            <div
              key={item.id}
              className={`terminal-tab ${item.id === activeId ? 'active' : ''}`}
            >
              <button
                role="tab"
                aria-selected={item.id === activeId}
                onClick={() => setActiveId(item.id)}
                title={item.cwd}
              >
                <span className={`terminal-dot ${item.alive ? 'ok' : 'dead'}`} />
                {item.title}
              </button>
              <button
                className="terminal-tab-close"
                aria-label={`关闭 ${item.title}`}
                title="关闭终端"
                onClick={() => void closeTerminal(item.id)}
              >
                <CloseIcon size={11} />
              </button>
            </div>
          ))}
          <button className="icon-btn subtle terminal-new" onClick={() => void create()} aria-label="新建终端" title="新建终端">
            <PlusIcon size={14} />
          </button>
        </div>
        <div className="terminal-actions">
          <button className="icon-btn subtle" onClick={clearActive} aria-label="清屏" title="清屏">
            <TrashIcon size={14} />
          </button>
          <button
            className={`icon-btn subtle ${expanded ? 'active' : ''}`}
            onClick={() => setExpanded(value => !value)}
            aria-label={expanded ? '收起终端' : '展开终端'}
            title={expanded ? '收起' : '展开'}
          >
            {expanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
          </button>
          <button className="icon-btn subtle" onClick={onClose} aria-label="隐藏终端" title="隐藏终端">
            <CloseIcon size={14} />
          </button>
        </div>
      </div>

      {error ? <div className="terminal-error">{error}</div> : null}

      <div className="terminal-body" ref={bodyRef}>
        {terminals.length
          ? (
            <div className="terminal-screens">
              {terminals.map(item => (
                <div
                  key={item.id}
                  ref={(element) => attach(item.id, element)}
                  className={`terminal-screen ${item.id === activeId ? 'active' : ''}`}
                />
              ))}
            </div>
          )
          : null}
        {!terminals.length && !error
          ? (
            <div className="terminal-empty">
              没有终端
              <button className="btn ghost compact" onClick={() => void create()}>新建终端</button>
            </div>
          )
          : null}
      </div>
    </section>
  )
}

/** Insert or replace by id; a create response and a `changed` frame race. */
export function upsert(list: TerminalInfo[], next: TerminalInfo): TerminalInfo[] {
  const index = list.findIndex(item => item.id === next.id)
  if (index < 0) return [...list, next]
  const copy = [...list]
  copy[index] = next
  return copy
}

/**
 * Merge a server snapshot with the current list.
 *
 * The server is authoritative for membership; local entries it has not heard
 * about yet (an in-flight create) are kept, and duplicate ids collapse.
 */
export function merge(current: TerminalInfo[], snapshot: TerminalInfo[]): TerminalInfo[] {
  const seen = new Set(snapshot.map(item => item.id))
  const merged = [...snapshot]
  for (const item of current) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}

function themeOf() {
  const dark = document.documentElement.dataset.theme === 'dark'
  return dark
    ? { background: '#191918', foreground: '#e8e6e1', cursor: '#d97757', selectionBackground: '#33231d' }
    : { background: '#f7f7f5', foreground: '#2b2a26', cursor: '#c96442', selectionBackground: '#f5e7e0' }
}
