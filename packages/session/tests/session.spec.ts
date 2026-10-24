import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '../src/index.ts'

describe('session service', () => {
  it('derives metadata and projections from the event log', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionService)
    await fiber

    const meta = ctx.sessions.create({ model: 'mock-1' })
    ctx.sessions.registerProjection('userMessages', {
      init: () => 0,
      apply: (count, event) => event.type === 'message/user' ? count + 1 : count,
    })

    ctx.sessions.append(meta.id, 'message/user', { id: 'm1', text: 'hello', at: 1 })
    ctx.sessions.rename(meta.id, 'Renamed')

    const record = ctx.sessions.get(meta.id)!
    expect(record.meta.title).toBe('Renamed')
    expect(record.meta.model).toBe('mock-1')
    expect(record.events).toHaveLength(3)
    expect(ctx.sessions.view<{ userMessages: number }>(meta.id)?.userMessages).toBe(1)

    await fiber.dispose()
  })

  it('restores a session without emitting or duplicating events', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionService)
    await fiber

    ctx.sessions.restore(
      { id: 'a', title: 'New session', createdAt: 1, updatedAt: 2 },
      [
        { seq: 0, ts: 2, type: 'session/title', data: { title: 'Restored' } },
        { seq: 1, ts: 3, type: 'message/user', data: { id: 'm', text: 'hi', at: 3 } },
      ],
    )

    expect(ctx.sessions.get('a')?.meta.title).toBe('Restored')
    expect(ctx.sessions.get('a')?.events).toHaveLength(2)

    await fiber.dispose()
  })
})
