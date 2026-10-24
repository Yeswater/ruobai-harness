import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon } from './Icons.tsx'

export interface SelectOption {
  value: string
  label: string
  description?: string
  icon?: ReactNode
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel?: string
  className?: string
  menuWidth?: number
}

interface MenuPosition {
  left: number
  width: number
  top?: number
  bottom?: number
}

/** Custom popover select: native `<select>` menus cannot be styled. */
export function Select({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  className,
  menuWidth,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = options.find(option => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.max(menuWidth ?? rect.width, 180)
      const openUp = rect.bottom + 320 > window.innerHeight
      setPosition({
        left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
        width,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
      })
    }
    update()

    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      if (triggerRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, menuWidth])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger ${className ?? ''}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="select-value">{current?.label ?? value}</span>
        <ChevronDownIcon size={12} />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="select-menu"
              role="listbox"
              aria-label={ariaLabel}
              style={{
                left: position.left,
                width: position.width,
                ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
              }}
            >
              {options.map(option => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`select-option ${option.value === value ? 'selected' : ''}`}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  {option.icon ? <span className="select-option-icon">{option.icon}</span> : null}
                  <span className="select-option-body">
                    <span className="select-option-label">{option.label}</span>
                    {option.description ? <span className="select-option-desc">{option.description}</span> : null}
                  </span>
                  {option.value === value ? <CheckIcon size={13} /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
