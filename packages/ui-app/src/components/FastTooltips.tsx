import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const SHOW_DELAY = 180
const MAX_WIDTH = 360

interface TipState {
  text: string
  left: number
  top: number
  above: boolean
}

/**
 * Replaces the browser's slow native `title` tooltip with an instant one.
 * The title is parked on a data attribute while hovered so the OS tooltip
 * never appears, then restored on leave.
 */
export function FastTooltips() {
  const [tip, setTip] = useState<TipState | null>(null)
  const timer = useRef<number | null>(null)
  const current = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const clearTimer = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }

    const hide = () => {
      clearTimer()
      const element = current.current
      if (element) {
        const original = element.dataset.fastTip
        if (original !== undefined) {
          element.setAttribute('title', original)
          delete element.dataset.fastTip
        }
        current.current = null
      }
      setTip(null)
    }

    const place = (element: HTMLElement): TipState | null => {
      const text = element.dataset.fastTip?.trim()
      if (!text) return null
      const rect = element.getBoundingClientRect()
      if (!rect.width && !rect.height) return null
      const half = Math.min(MAX_WIDTH, window.innerWidth - 16) / 2
      const left = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8)
      const above = rect.top > 72
      return { text, left, top: above ? rect.top - 8 : rect.bottom + 8, above }
    }

    const show = (element: HTMLElement) => {
      if (current.current !== element) return
      const next = place(element)
      if (next) setTip(next)
    }

    const onOver = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      const element = target?.closest?.('[title]') as HTMLElement | null
      if (!element || element === current.current) return
      if (element.closest('.fast-tooltip')) return
      const title = element.getAttribute('title')?.trim()
      if (!title) return
      hide()
      current.current = element
      element.dataset.fastTip = title
      element.removeAttribute('title')
      clearTimer()
      timer.current = window.setTimeout(() => show(element), SHOW_DELAY)
    }

    const onOut = (event: PointerEvent) => {
      const element = current.current
      if (!element) return
      const related = event.relatedTarget as Node | null
      if (related && element.contains(related)) return
      hide()
    }

    const onDown = () => hide()
    const onScroll = () => hide()
    const onResize = () => hide()

    document.addEventListener('pointerover', onOver, true)
    document.addEventListener('pointerout', onOut, true)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('pointerout', onOut, true)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', onResize)
      hide()
    }
  }, [])

  if (!tip) return null
  return createPortal(
    <div
      className={`fast-tooltip ${tip.above ? 'above' : 'below'}`}
      style={{ left: tip.left, top: tip.top }}
      role="tooltip"
    >
      {tip.text}
    </div>,
    document.body,
  )
}
