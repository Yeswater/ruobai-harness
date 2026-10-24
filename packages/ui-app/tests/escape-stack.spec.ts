import { describe, expect, it, vi } from 'vitest'
import { createEscapeStack, handleEscapeEvent } from '../src/escape-stack.ts'

function escapeEvent(key = 'Escape') {
  return {
    key,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
}

describe('escape stack', () => {
  it('only closes the most recently opened layer', () => {
    const stack = createEscapeStack()
    const dialog = vi.fn()
    const dropdown = vi.fn()
    stack.push(dialog)
    const releaseDropdown = stack.push(dropdown)

    expect(stack.dispatch()).toBe(true)
    expect(dropdown).toHaveBeenCalledOnce()
    expect(dialog).not.toHaveBeenCalled()

    // Closing the dropdown unmounts it; the next press reaches the dialog.
    releaseDropdown()
    stack.dispatch()
    expect(dialog).toHaveBeenCalledOnce()
  })

  it('releases handlers on unmount, in any order', () => {
    const stack = createEscapeStack()
    const first = vi.fn()
    const second = vi.fn()
    const releaseFirst = stack.push(first)
    const releaseSecond = stack.push(second)

    releaseFirst()
    expect(stack.size()).toBe(1)
    stack.dispatch()
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()

    releaseSecond()
    releaseSecond()
    expect(stack.size()).toBe(0)
    expect(stack.dispatch()).toBe(false)
  })

  it('does nothing when no layer is open', () => {
    const stack = createEscapeStack()
    const event = escapeEvent()
    expect(handleEscapeEvent(event, stack)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('claims Escape for the top layer so no other handler reacts', () => {
    const stack = createEscapeStack()
    stack.push(vi.fn())
    const event = escapeEvent()
    expect(handleEscapeEvent(event, stack)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('ignores other keys and IME composition', () => {
    const stack = createEscapeStack()
    const handler = vi.fn()
    stack.push(handler)

    expect(handleEscapeEvent(escapeEvent('Enter'), stack)).toBe(false)
    expect(handleEscapeEvent({ ...escapeEvent(), isComposing: true }, stack)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})
