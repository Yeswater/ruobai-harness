/**
 * Layered Escape handling.
 *
 * Every closable layer (dialog, palette, dropdown) pushes a handler while it is
 * open. The module owns one document-level capture listener, so a single press
 * only closes the topmost layer: a dropdown inside the settings dialog swallows
 * the first Escape, the dialog the second. Capture also keeps the event away
 * from element-level handlers, which would otherwise react a second time.
 */

export type EscapeHandler = () => void

export interface EscapeStack {
  /** Registers a handler; returns the idempotent release function. */
  push: (handler: EscapeHandler) => () => void
  /** Number of layers currently registered. */
  size: () => number
  /** Runs the topmost handler; false when the stack is empty. */
  dispatch: () => boolean
}

export function createEscapeStack(): EscapeStack {
  const handlers: EscapeHandler[] = []

  return {
    push(handler) {
      handlers.push(handler)
      let released = false
      return () => {
        if (released) return
        released = true
        const index = handlers.lastIndexOf(handler)
        if (index !== -1) handlers.splice(index, 1)
      }
    },
    size: () => handlers.length,
    dispatch() {
      const top = handlers.at(-1)
      if (!top) return false
      top()
      return true
    },
  }
}

export const escapeStack = createEscapeStack()

/**
 * Handles one keydown against the stack. Returns true when a layer consumed it,
 * so callers can tell whether Escape was meaningful.
 */
export function handleEscapeEvent(
  event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'preventDefault' | 'stopPropagation'>,
  stack: EscapeStack = escapeStack,
) {
  if (event.key !== 'Escape' || event.isComposing) return false
  if (!stack.dispatch()) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

let listening = false

function listen(stack: EscapeStack) {
  if (listening) return
  if (typeof document === 'undefined') return
  listening = true
  document.addEventListener('keydown', event => handleEscapeEvent(event, stack), true)
}

/** Pushes a handler onto the shared stack and makes sure it is being listened to. */
export function pushEscape(handler: EscapeHandler) {
  const release = escapeStack.push(handler)
  listen(escapeStack)
  return release
}
