import {
  createContext, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode,
} from 'react'
import { ChevronDownIcon } from '../Icons.tsx'

/**
 * Base UI kit shared by settings and, later, the rest of the app.
 * Every visual rule lives in design-system.css; this file only shapes markup
 * and behavior so a second skin can restyle without touching components.
 */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

export function Button({
  variant = 'default', small, className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean }) {
  const classes = ['ui-btn']
  if (variant !== 'default') classes.push(variant)
  if (small) classes.push('sm')
  if (className) classes.push(className)
  return <button className={classes.join(' ')} {...rest}>{children}</button>
}

export function IconButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`ui-icon-btn ${className ?? ''}`.trim()} {...rest}>{children}</button>
}

export function Field({ label, hint, error, children }: {
  label: string
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="ui-field">
      <span className="ui-label">{label}</span>
      {children}
      {error ? <span className="ui-error">{error}</span> : hint ? <span className="ui-hint">{hint}</span> : null}
    </label>
  )
}

export function Switch({ checked, onChange, disabled, label }: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      className="ui-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: Array<{ value: T; label: ReactNode; title?: string; ariaLabel?: string }>
  onChange: (next: T) => void
  label: string
}) {
  return (
    <div className="ui-seg" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          {...(option.ariaLabel ? { 'aria-label': option.ariaLabel } : {})}
          {...(option.title ? { title: option.title } : {})}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const DisclosureContext = createContext<{ open: boolean; toggle: () => void } | null>(null)

export function Disclosure({ title, meta, defaultOpen = false, children }: {
  title: ReactNode
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <DisclosureContext.Provider value={{ open, toggle: () => setOpen(current => !current) }}>
      <div className="ui-disclosure">
        <button
          type="button"
          className="ui-disclosure-head"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(current => !current)}
        >
          <span className="ui-disclosure-chevron"><ChevronDownIcon size={13} /></span>
          <span className="ui-disclosure-title">{title}</span>
          {meta ? <span className="ui-disclosure-meta">{meta}</span> : null}
        </button>
        {open ? <div className="ui-disclosure-body" id={id}>{children}</div> : null}
      </div>
    </DisclosureContext.Provider>
  )
}

export function Notice({ tone = 'neutral', children }: {
  tone?: 'neutral' | 'ok' | 'error'
  children: ReactNode
}) {
  return <div className={`ui-notice ${tone === 'neutral' ? '' : tone}`.trim()}>{children}</div>
}

export type ToastTone = 'neutral' | 'ok' | 'error'

/**
 * Transient, layout-neutral feedback (saved, copied, failed). Placement is the
 * caller's job — the settings shell pins it to the page header — while tone,
 * dot, radius and motion stay identical everywhere.
 */
export function Toast({ tone = 'neutral', children }: { tone?: ToastTone; children: ReactNode }) {
  return (
    <span className={`ui-toast ${tone}`} role="status" aria-live="polite">
      {children}
    </span>
  )
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-empty">
      <strong>{title}</strong>
      {children ? <span>{children}</span> : null}
    </div>
  )
}

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/** Debounced autosave for preference panels; flushes on unmount. */
export function useAutosave<T>(save: (value: T) => Promise<void>, delay = 450) {
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<T | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const saveRef = useRef(save)
  saveRef.current = save

  const flush = async () => {
    const value = pending.current
    if (value === null) return
    pending.current = null
    setState('saving')
    setError(null)
    try {
      await saveRef.current(value)
      setState('saved')
    } catch (caught) {
      setState('error')
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const schedule = (value: T) => {
    pending.current = value
    setState('dirty')
    setError(null)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flush(), delay)
  }

  useEffect(() => () => {
    window.clearTimeout(timer.current)
    if (pending.current !== null) void saveRef.current(pending.current)
  }, [])

  return { state, error, schedule, flush }
}
