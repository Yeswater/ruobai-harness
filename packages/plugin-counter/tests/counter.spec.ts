import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import CounterService from '../src/index.ts'

describe('counter service', () => {
  it('provides ctx.counter and emits changes', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(CounterService, { initial: 3 })
    await fiber

    expect(ctx.counter.current).toBe(3)

    const seen: number[] = []
    ctx.on('counter/changed', value => seen.push(value))

    expect(ctx.counter.increment(2)).toBe(5)
    expect(seen).toEqual([5])

    await fiber.dispose()
    expect(ctx.get('counter')).toBeUndefined()
  })

  it('keeps the service visible to dependents only while loaded', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(CounterService, { initial: 1 })
    await fiber
    expect(ctx.counter.current).toBe(1)
    await fiber.dispose()
    expect(ctx.get('counter')).toBeUndefined()
  })
})
