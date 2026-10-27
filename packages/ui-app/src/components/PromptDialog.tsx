import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export interface PromptOptions {
  /** Question in the dialog header, e.g. 「新建目录」. */
  title: string
  /** Optional hint under the field. */
  body?: ReactNode
  placeholder?: string
  /** Pre-filled value. */
  value?: string
  confirmLabel?: string
  cancelLabel?: string
}

type Prompt = (options: PromptOptions) => Promise<string | null>

const PromptContext = createContext<Prompt | null>(null)

/**
 * In-app replacement for `window.prompt`.
 *
 * Native dialogs block the renderer, ignore the theme and cannot be styled, so
 * text input asks through this instead. Resolves the trimmed value, or `null`
 * when the user cancels.
 */
export function usePrompt() {
  const prompt = useContext(PromptContext)
  if (!prompt) throw new Error('usePrompt must be used inside PromptProvider')
  return prompt
}

interface PendingState {
  options: PromptOptions
  resolve: (value: string | null) => void
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null)
  const pendingRef = useRef<PendingState | null>(null)

  const settle = useCallback((value: string | null) => {
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    current?.resolve(value)
  }, [])

  const prompt = useCallback<Prompt>((options) => {
    // A second request supersedes the first; the earlier promise resolves null.
    pendingRef.current?.resolve(null)
    return new Promise<string | null>((resolve) => {
      const next = { options, resolve }
      pendingRef.current = next
      setPending(next)
    })
  }, [])

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {pending ? createPortal(
        <PromptDialog
          options={pending.options}
          onCancel={() => settle(null)}
          onSubmit={value => settle(value.trim() || null)}
        />,
        document.body,
      ) : null}
    </PromptContext.Provider>
  )
}

function PromptDialog({ options, onCancel, onSubmit }: {
  options: PromptOptions
  onCancel: () => void
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(options.value ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-backdrop confirm-backdrop" onClick={onCancel}>
      <div
        className="modal confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{options.title}</h2>
        </div>
        <div className="modal-body">
          <input
            ref={inputRef}
            className="confirm-input"
            value={value}
            placeholder={options.placeholder}
            onChange={event => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onSubmit(value)
              }
            }}
          />
          {options.body ? <p className="modal-note">{options.body}</p> : null}
        </div>
        <div className="modal-foot confirm-foot">
          <div className="modal-actions">
            <button className="btn ghost" onClick={onCancel}>{options.cancelLabel ?? '取消'}</button>
            <button className="btn" disabled={!value.trim()} onClick={() => onSubmit(value)}>
              {options.confirmLabel ?? '确定'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
