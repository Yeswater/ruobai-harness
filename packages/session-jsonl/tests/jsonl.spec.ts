import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('fills in visibility for rows written before the field existed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-sessions-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))

    const rows = [
      { type: 'session', version: 1, id: 'legacy', createdAt: 1 },
      { seq: 0, ts: 2, type: 'session/title', data: { title: 'Legacy' } },
      { seq: 1, ts: 3, type: 'message/user', data: { id: 'm', text: 'hi', at: 3 } },
      { seq: 2, ts: 4, type: 'tool/result', data: { id: 't', content: 'x', at: 4 } },
    ]
    await writeFile(join(root, 'legacy.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')

    const ctx = new Context()
    const sessions = ctx.plugin(SessionService)
    await sessions
    const store = ctx.plugin(SessionJsonl, { root })
    await store

    const events = ctx.sessions.get('legacy')!.events
    expect(events.find(event => event.type === 'message/user')?.visibility).toBe('client')
    expect(events.find(event => event.type === 'tool/result')?.visibility).toBe('internal')
    expect(events.find(event => event.type === 'session/title')?.visibility).toBe('internal')

    await store.dispose()
    await sessions.dispose()
  })

  it('records a persist error when the log cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-sessions-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))

    const ctx = new Context()
    const sessions = ctx.plugin(SessionService)
    await sessions
    const store = ctx.plugin(SessionJsonl, { root })
    await store

    const meta = ctx.sessions.create({ title: 'x' })
    await ctx.sessionJsonl.flush()

    // The directory stays writable; the already-created log file is what turns
    // read-only, which is the realistic "disk went read-only" failure.
    const file = join(root, `${meta.id}.jsonl`)
    await chmod(file, 0o400)
    ctx.sessions.append(meta.id, 'message/user', { id: 'm', text: 'hi', at: 1 })
    await ctx.sessionJsonl.flush()

    const failure = ctx.sessions.get(meta.id)!.events.find(event => event.type === 'session/persist-error')
    expect(failure?.data.phase).toBe('enter')
    expect(ctx.sessionJsonl.status().failing).toBe(true)

    await chmod(file, 0o600)
    ctx.sessions.append(meta.id, 'message/user', { id: 'm2', text: 'again', at: 2 })
    await ctx.sessionJsonl.flush()

    const recovered = ctx.sessions.get(meta.id)!.events
      .filter(event => event.type === 'session/persist-error')
      .at(-1)
    expect(recovered?.data.phase).toBe('recover')
    expect(ctx.sessionJsonl.status().failing).toBe(false)

    await store.dispose()
    await sessions.dispose()
  })
})
