import { useEffect, useRef, useState } from 'react'

export interface MenuPosition {
  left: number
  width: number
  top?: number
  bottom?: number
}

interface Options {
  open: boolean
  onClose: () => void
  width: number
}

/** Portal positioning + outside-click/Escape handling shared by composer menus. */
export function useAnchoredMenu({ open, onClose, width }: Options) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [position, setPosition] = useState<MenuPosition | null>(null)

  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const openUp = rect.bottom + 360 > window.innerHeight
      setPosition({
        left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
        width,
        ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      })
    }
    update()

    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      if (triggerRef.current?.contains(event.target as Node)) return
      closeRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
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
  }, [open, width])

  return { triggerRef, menuRef, position }
}
