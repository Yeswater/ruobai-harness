import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label?: string
  shortcut?: string
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

interface MenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

interface ContextMenuApi {
  open: (event: ReactMouseEvent, items: ContextMenuItem[]) => void
  close: () => void
}

const ContextMenuContext = createContext<ContextMenuApi | null>(null)

export function useContextMenu() {
  const value = useContext(ContextMenuContext)
  if (!value) throw new Error('useContextMenu must be used inside ContextMenuProvider')
  return value
}

/**
 * Replaces the browser's context menu across the app. Components call
 * `open(event, items)`; anything else falls back to the document-level
 * suppressor, so the native menu never appears.
 */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null)

  const close = useCallback(() => setMenu(null), [])

  const open = useCallback((event: ReactMouseEvent, items: ContextMenuItem[]) => {
    const usable = items.filter(item => item.separator || item.label)
    event.preventDefault()
    event.stopPropagation()
    if (!usable.length) {
      setMenu(null)
      return
    }
    setMenu({ x: event.clientX, y: event.clientY, items: usable })
  }, [])

  useEffect(() => {
    const suppress = (event: MouseEvent) => event.preventDefault()
    document.addEventListener('contextmenu', suppress)
    return () => document.removeEventListener('contextmenu', suppress)
  }, [])

  useEffect(() => {
    if (!menu) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.context-menu')) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu, close])

  return (
    <ContextMenuContext.Provider value={{ open, close }}>
      {children}
      {menu ? createPortal(<Menu state={menu} onClose={close} />, document.body) : null}
    </ContextMenuContext.Provider>
  )
}

function Menu({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: state.x, top: state.y })

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.max(8, Math.min(state.x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8))
    setPosition({ left, top })
  }, [state.x, state.y])

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={event => event.preventDefault()}
    >
      {state.items.map((item, index) => item.separator
        ? <div className="context-menu-sep" key={`sep-${index}`} role="separator" />
        : (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            className={`context-menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect?.()
            }}
          >
            <span>{item.label}</span>
            {item.shortcut ? <span className="context-menu-key">{item.shortcut}</span> : null}
          </button>
        ))}
    </div>
  )
}

/**
 * Cut/copy/paste/select-all for inputs, driven by the native value setter so
 * React's onChange still sees the edit.
 */
export function editableContextMenu(element: HTMLInputElement | HTMLTextAreaElement): ContextMenuItem[] {
  const start = element.selectionStart ?? 0
  const end = element.selectionEnd ?? 0
  const selected = element.value.slice(start, end)

  const replaceSelection = (text: string) => {
    const next = element.value.slice(0, start) + text + element.value.slice(end)
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, next)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    const caret = start + text.length
    element.setSelectionRange(caret, caret)
    element.focus()
  }

  return [
    {
      label: '剪切',
      shortcut: '⌘X',
      disabled: !selected,
      onSelect: () => {
        void navigator.clipboard.writeText(selected)
        replaceSelection('')
      },
    },
    {
      label: '复制',
      shortcut: '⌘C',
      disabled: !selected,
      onSelect: () => { void navigator.clipboard.writeText(selected) },
    },
    { separator: true },
    {
      label: '粘贴',
      shortcut: '⌘V',
      onSelect: () => {
        navigator.clipboard.readText()
          .then(text => { if (text) replaceSelection(text) })
          .catch(() => undefined)
      },
    },
    { separator: true },
    {
      label: '全选',
      shortcut: '⌘A',
      onSelect: () => {
        element.focus()
        element.select()
      },
    },
  ]
}
