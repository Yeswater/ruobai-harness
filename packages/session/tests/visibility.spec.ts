import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '../src/index.ts'
import { inferVisibility, visibleTo } from '../src/visibility.ts'

describe('event visibility', () => {
  it('infers client visibility for conversation content', () => {
    expect(inferVisibility('message/user')).toBe('client')
    expect(inferVisibility('message/assistant')).toBe('client')
  })

  it('keeps tool output and internal machinery internal', () => {
    expect(inferVisibility('tool/result')).toBe('internal')
    expect(inferVisibility('tool/call')).toBe('internal')
    expect(inferVisibility('hooks/blocked')).toBe('internal')
    expect(inferVisibility('file/change')).toBe('internal')
    expect(inferVisibility('contract/opened')).toBe('internal')
    expect(inferVisibility('delivery/verdict')).toBe('internal')
  })

  it('marks settings and secrets as secret', () => {
    expect(inferVisibility('settings/updated')).toBe('secret')
    expect(inferVisibility('secrets/migrated')).toBe('secret')
    expect(inferVisibility('mcp/config')).toBe('secret')
  })

  it('defaults unknown event types to internal', () => {
    expect(inferVisibility('some/unknown')).toBe('internal')
    expect(inferVisibility('')).toBe('internal')
  })

  it('filters events for the client scope', () => {
    const client = { seq: 0, ts: 1, type: 'message/user', data: {}, visibility: 'client' as const }
    const internal = { seq: 1, ts: 2, type: 'tool/result', data: {}, visibility: 'internal' as const }
    const secret = { seq: 2, ts: 3, type: 'secrets/migrated', data: {}, visibility: 'secret' as const }

    expect(visibleTo(client, 'client')).toBe(true)
    expect(visibleTo(internal, 'client')).toBe(false)
    expect(visibleTo(secret, 'client')).toBe(false)
    expect(visibleTo(internal, 'internal')).toBe(true)
    expect(visibleTo(secret, 'internal')).toBe(true)
  })

  it('falls back to the inferred value when the field is missing', () => {
    expect(visibleTo({ seq: 0, ts: 1, type: 'message/user', data: {} }, 'client')).toBe(true)
    expect(visibleTo({ seq: 0, ts: 1, type: 'tool/result', data: {} }, 'client')).toBe(false)
  })

  it('stamps visibility on append and keeps it through fork', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionService)
    await fiber

    const meta = ctx.sessions.create({ title: 'Visible' })
    const user = ctx.sessions.append(meta.id, 'message/user', { id: 'm', text: 'hi', at: 1 })
    const tool = ctx.sessions.append(meta.id, 'tool/result', { id: 't', content: 'x', at: 2 })
    const secret = ctx.sessions.append(meta.id, 'settings/updated', { at: 3 }, { visibility: 'secret' })

    expect(user.visibility).toBe('client')
    expect(tool.visibility).toBe('internal')
    expect(secret.visibility).toBe('secret')

    const fork = ctx.sessions.fork(meta.id)
    const forked = ctx.sessions.get(fork.id)!
    expect(forked.events.find(event => event.type === 'message/user')?.visibility).toBe('client')
    expect(forked.events.find(event => event.type === 'settings/updated')?.visibility).toBe('secret')

    await fiber.dispose()
  })

  it('lets a plugin override the inferred value', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionService)
    await fiber

    const meta = ctx.sessions.create()
    const event = ctx.sessions.append(meta.id, 'message/user', { id: 'm', text: 'pii', at: 1 }, { visibility: 'secret' })
    expect(event.visibility).toBe('secret')

    await fiber.dispose()
  })
})
