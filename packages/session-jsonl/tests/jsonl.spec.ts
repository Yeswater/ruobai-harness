import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import SessionJsonl from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('session jsonl', () => {
  it('persists events and reloads them into a fresh context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-sessions-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))

    const first = new Context()
    const sessionsA = first.plugin(SessionService)
    await sessionsA
    const storeA = first.plugin(SessionJsonl, { root })
    await storeA

    const meta = first.sessions.create({ title: 'Persisted', model: 'mock-1' })
    first.sessions.append(meta.id, 'message/user', { id: 'm1', text: 'hello', at: 1 })
    first.sessions.rename(meta.id, 'Persisted chat')
    await first.sessionJsonl.flush()

    await storeA.dispose()
    await sessionsA.dispose()

    const second = new Context()
    const sessionsB = second.plugin(SessionService)
    await sessionsB
    const storeB = second.plugin(SessionJsonl, { root })
    await storeB

    const restored = second.sessions.get(meta.id)
    expect(restored?.meta.title).toBe('Persisted chat')
    expect(restored?.meta.model).toBe('mock-1')
    expect(restored?.events.map(event => event.type)).toEqual([
      'session/title',
      'session/meta',
      'message/user',
      'session/title',
    ])

    await storeB.dispose()
    await sessionsB.dispose()
  })
})
