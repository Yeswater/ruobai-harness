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

  it('persists a creation title as an event', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionService)
    await fiber

    const meta = ctx.sessions.create({ title: 'Named at creation' })
    expect(meta.title).toBe('Named at creation')
    expect(ctx.sessions.get(meta.id)?.events.some(event =>
      event.type === 'session/title' && event.data.title === 'Named at creation')).toBe(true)

    await fiber.dispose()
  })

  it('forks a log into a new session without carrying source metadata or summaries', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionService)
    await fiber

    const source = ctx.sessions.create({ title: 'Source', model: 'mock-1', mode: 'agent' })
    ctx.sessions.append(source.id, 'message/user', { id: 'm1', text: 'first', at: 1 })
    ctx.sessions.append(source.id, 'context/summary', { upToSeq: 2, text: 'older' })
    ctx.sessions.append(source.id, 'message/user', { id: 'm2', text: 'second', at: 2 })

    const fork = ctx.sessions.fork(source.id)
    const record = ctx.sessions.get(fork.id)!

    expect(fork.id).not.toBe(source.id)
    expect(fork.title).toBe('Source (fork)')
    expect(fork.model).toBe('mock-1')
    expect(fork.mode).toBe('agent')
    expect(record.events.filter(event => event.type === 'message/user').map(event => event.data.id))
      .toEqual(['m1', 'm2'])
    expect(record.events.some(event => event.type === 'context/summary')).toBe(false)
    expect(ctx.sessions.get(source.id)?.events).toHaveLength(5)

    const partial = ctx.sessions.fork(source.id, { upToSeq: 3, title: 'Half' })
    expect(ctx.sessions.get(partial.id)?.events.filter(event => event.type === 'message/user')).toHaveLength(1)

    await fiber.dispose()
  })

  it('removes a session and emits a removal event', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionService)
    await fiber

    const meta = ctx.sessions.create()
    const removed = new Promise<string>(resolve => ctx.once('session/removed', resolve))
    ctx.sessions.remove(meta.id)

    await expect(removed).resolves.toBe(meta.id)
    expect(ctx.sessions.has(meta.id)).toBe(false)

    await fiber.dispose()
  })

  it('keeps a broken projection from failing the append', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionService)
    await fiber

    ctx.sessions.registerProjection('broken', {
      init: () => 0,
      apply: () => {
        throw new Error('boom')
      },
    })

    const meta = ctx.sessions.create()
    const event = ctx.sessions.append(meta.id, 'message/user', { id: 'm', text: 'hi', at: 1 })

    // The event is a fact; a derivative view must not make the append fail.
    expect(event.seq).toBeTypeOf('number')
    const events = ctx.sessions.get(meta.id)!.events
    expect(events.some(candidate => candidate.type === 'message/user')).toBe(true)
    const failure = events.find(candidate => candidate.type === 'projection/error')
    expect(failure?.data.key).toBe('broken')
    expect(failure?.data.message).toContain('boom')

    await fiber.dispose()
  })
})
