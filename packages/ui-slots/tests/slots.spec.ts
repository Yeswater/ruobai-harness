import { describe, expect, it } from 'vitest'
import { createSlots } from '../src/index.ts'

describe('slot registry', () => {
  it('orders entries and returns stable snapshots', () => {
    const slots = createSlots<string>()
    const first = slots.list('sidebar.footer')
    expect(slots.list('sidebar.footer')).toBe(first)

    slots.register('sidebar.footer', { id: 'b', order: 20, component: 'B' })
    slots.register('sidebar.footer', { id: 'a', order: 10, component: 'A' })

    expect(slots.list('sidebar.footer').map(entry => entry.component)).toEqual(['A', 'B'])
    const snapshot = slots.list('sidebar.footer')
    expect(slots.list('sidebar.footer')).toBe(snapshot)
  })

  it('notifies subscribers and disposes registrations', () => {
    const slots = createSlots<string>()
    let calls = 0
    const off = slots.subscribe(() => {
      calls += 1
    })

    const remove = slots.register('header.actions', { id: 'x', component: 'X' })
    expect(calls).toBe(1)
    remove()
    expect(calls).toBe(2)
    expect(slots.list('header.actions')).toHaveLength(0)

    off()
    remove()
    expect(calls).toBe(2)
  })

  it('rejects duplicate ids in one slot', () => {
    const slots = createSlots<string>()
    slots.register('details.side', { id: 'x', component: 'X' })
    expect(() => slots.register('details.side', { id: 'x', component: 'Y' })).toThrow()
  })
})
