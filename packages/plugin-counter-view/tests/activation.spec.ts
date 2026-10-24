import { describe, expect, it } from 'vitest'
import { Context, FiberState } from '@ruobai/cordis'
import TimerService from '@ruobai/cordis-plugin-timer'
import CounterService from '@ruobai/plugin-counter'
import * as CounterView from '../src/index.ts'

describe('counter view', () => {
  it('stays PENDING until every injected service exists', async () => {
    const ctx = new Context()

    const view = ctx.plugin(CounterView)
    expect(view.state).toBe(FiberState.PENDING)

    const timer = ctx.plugin(TimerService)
    await timer
    expect(view.state).toBe(FiberState.PENDING)

    const counter = ctx.plugin(CounterService, { initial: 2 })
    await counter
    await view
    expect(view.state).toBe(FiberState.ACTIVE)

    await view.dispose()
    expect(view.state).toBe(FiberState.DISPOSED)

    await counter.dispose()
    await timer.dispose()
  })
})
