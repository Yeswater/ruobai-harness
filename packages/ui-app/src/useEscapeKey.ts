import { useEffect, useRef } from 'react'
import { pushEscape } from './escape-stack.ts'

/**
 * Escape closes `handler` while `active`. Layers stack, so the most recently
 * opened surface is the one that closes.
 */
export function useEscapeKey(handler: () => void, active = true) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!active) return
    return pushEscape(() => handlerRef.current())
  }, [active])
}
