import { afterEach, describe, expect, it } from 'vitest'
import type { ModelRequest } from '@ruobai/llm'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

/** A provider that records every request and always answers in one step. */
async function scripted(harness: Harness, requests: ModelRequest[]) {
  harness.ctx.effect(() => harness.ctx.llm.register({
    name: 'probe',
    models: ['probe-1'],
    async *stream(request) {
      requests.push(request)
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'done', reason: 'stop' }
    },
  }))
  await harness.ctx.settings.update({ llm: { activeProvider: 'probe', activeModel: 'probe-1' } })
}

function turn(harness: Harness, sessionId: string, text: string) {
  return new Promise<void>((resolve) => {
    harness.ctx.once('agent/turn-end', () => resolve())
    harness.ctx.chat.send(sessionId, text)
  })
}

describe('prompt cache interaction', () => {
  it('keeps the offered tool set stable when the permission preset changes', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const requests: ModelRequest[] = []
    await scripted(harness, requests)

    const session = harness.ctx.chat.create(undefined, 'agent')
    await turn(harness, session.id, 'first')
    harness.ctx.chat.setPermission(session.id, 'read-only')
    await turn(harness, session.id, 'second')

    const first = requests[0]!.tools!.map(tool => tool.name)
    const second = requests[1]!.tools!.map(tool => tool.name)
    expect(second).toEqual(first)
    // Deterministic order is part of the cache key.
    expect(second).toEqual([...second].sort())
    // Enforcement moved to invoke, not to the offered set.
    expect(second).toContain('write_file')
  })

  it('records a cache break when a mode switch reshapes the prefix', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const requests: ModelRequest[] = []
    await scripted(harness, requests)

    const session = harness.ctx.chat.create(undefined, 'agent')
    await turn(harness, session.id, 'first')
    harness.ctx.chat.setMode(session.id, 'plan')
    await turn(harness, session.id, 'second')

    expect(requests).toHaveLength(2)
    const events = harness.ctx.sessions.get(session.id)!.events
    const breaks = events.filter(event => event.type === 'context/cache-break')
    expect(breaks).toHaveLength(1)
    expect(breaks[0]!.data).toMatchObject({ reason: 'mode', region: 'tools' })
  })

  it('does not report a break when a turn only appends messages', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const requests: ModelRequest[] = []
    await scripted(harness, requests)

    const session = harness.ctx.chat.create(undefined, 'agent')
    await turn(harness, session.id, 'first')
    await turn(harness, session.id, 'second')

    const events = harness.ctx.sessions.get(session.id)!.events
    expect(events.some(event => event.type === 'context/cache-break')).toBe(false)
    // The second request repeats the first one's rendered messages verbatim.
    const previous = requests[0]!.messages
    const next = requests[1]!.messages
    expect(next.length).toBeGreaterThan(previous.length)
    expect(next.slice(0, previous.length)).toEqual(previous)
  })
})
