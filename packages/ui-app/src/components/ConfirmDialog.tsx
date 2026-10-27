import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export interface ConfirmOptions {
  /** Question in the dialog header, e.g. 「删除供应商」. */
  title: string
  /** Optional detail: what exactly is about to happen. */
  body?: ReactNode
  /** Confirm button label; defaults to 「确定」. */
  confirmLabel?: string
  /** Cancel button label; defaults to 「取消」. */
  cancelLabel?: string
  /** Style the confirm button as destructive. */
  danger?: boolean
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<Confirm | null>(null)

/**
 * In-app replacement for `window.confirm`.
 *
 * Native dialogs block the renderer, ignore the app's theme and cannot be
 * styled, so every destructive action asks through this instead. It resolves
 * `true` on confirm and `false` on cancel / Escape / backdrop click, which
 * makes it a drop-in for the old `if (!confirm(...)) return` call sites.
 */
export function useConfirm() {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmProvider')
  return confirm
}

interface PendingState {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null)
  const pendingRef = useRef<PendingState | null>(null)

  const settle = useCallback((value: boolean) => {
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    current?.resolve(value)
  }, [])

  const confirm = useCallback<Confirm>((options) => {
    // A second request supersedes the first rather than stacking dialogs; the
    // earlier promise resolves as cancel so its call site stops.
    pendingRef.current?.resolve(false)
    return new Promise<boolean>((resolve) => {
      const next = { options, resolve }
      pendingRef.current = next
      setPending(next)
    })
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? createPortal(
        <ConfirmDialog
          options={pending.options}
          onCancel={() => settle(false)}
          onConfirm={() => settle(true)}
        />,
        document.body,
      ) : null}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({ options, onCancel, onConfirm }: {
  options: ConfirmOptions
  onCancel: () => void
  onConfirm: () => void
}) {
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus the safe choice: for a destructive action that is the cancel
    // button, so a stray Enter cannot confirm it.
    primaryRef.current?.focus()
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
        role="alertdialog"
        aria-modal="true"
        aria-label={options.title}
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{options.title}</h2>
        </div>
        {options.body ? <div className="modal-body"><p className="modal-note">{options.body}</p></div> : null}
        <div className="modal-foot confirm-foot">
          <div className="modal-actions">
            <button
              ref={options.danger ? primaryRef : undefined}
              className="btn ghost"
              onClick={onCancel}
            >
              {options.cancelLabel ?? '取消'}
            </button>
            <button
              ref={options.danger ? undefined : primaryRef}
              className={`btn ${options.danger ? 'danger-solid' : ''}`}
              onClick={onConfirm}
            >
              {options.confirmLabel ?? '确定'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
