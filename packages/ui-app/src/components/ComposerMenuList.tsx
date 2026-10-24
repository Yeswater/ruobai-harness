import { useEffect, useRef, type ReactNode } from 'react'

export interface ComposerMenuItem {
  id: string
  label: string
  description?: string
  icon?: ReactNode
}

interface ComposerMenuListProps {
  title: string
  items: ComposerMenuItem[]
  activeIndex: number
  empty: string
  onPick: (id: string) => void
}

/** Floating keyboard-navigable list shared by the slash and mention menus. */
export function ComposerMenuList({ title, items, activeIndex, empty, onPick }: ComposerMenuListProps) {
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, items.length])

  return (
    <div className="composer-picker" role="listbox" aria-label={title}>
      <div className="composer-picker-head">{title}</div>
      {items.length
        ? items.map((item, index) => (
          <button
            key={item.id}
            ref={index === activeIndex ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`composer-picker-row ${index === activeIndex ? 'active' : ''}`}
            onMouseDown={event => event.preventDefault()}
            onClick={() => onPick(item.id)}
          >
            {item.icon ? <span className="composer-picker-icon">{item.icon}</span> : null}
            <span className="composer-picker-text">
              <span className="composer-picker-label">{item.label}</span>
              {item.description ? <span className="composer-picker-desc">{item.description}</span> : null}
            </span>
          </button>
        ))
        : <div className="composer-picker-empty">{empty}</div>}
    </div>
  )
}
