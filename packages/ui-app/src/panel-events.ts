import type { BrowserCastEvent, PreviewEvent, TerminalEvent } from './api.ts'

/**
 * Fan-out for panels that must not re-render the whole app per chunk.
 *
 * The live socket is owned by `useHarness`; terminal output can arrive many
 * times per second, so it is pushed to subscribers instead of React state.
 */
function createBus<T>() {
  const listeners = new Set<(event: T) => void>()
  return {
    emit(event: T) {
      for (const listener of listeners) listener(event)
    },
    subscribe(listener: (event: T) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export const terminalBus = createBus<TerminalEvent>()
export const previewBus = createBus<PreviewEvent>()
/** Screencast frames of the page the agent is driving; high rate, so a bus. */
export const browserBus = createBus<BrowserCastEvent>()
