import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { ChatEvent } from '@ruobai/chat-protocol'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

async function waitFor<T>(check: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const value = check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('web ws', () => {
  it('accepts upgrades and broadcasts chat events', async () => {
    const harness = await createHarness({ delay: 5 })
    harnesses.push(harness)
    const base = harness.ctx.web.url

    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/ws`)
    const frames: any[] = []
    socket.on('message', (data) => {
      frames.push(JSON.parse(String(data)))
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    const hello = await waitFor(() => frames.find(item => item.type === 'hello'), 'hello')
    expect(hello.url).toBe(base)

    const createdResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ws' }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { session: { id: string } }

    const sent = await fetch(`${base}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello over ws' }),
    })
    expect(sent.status).toBe(201)

    const event = await waitFor(
      () => frames.find(item => item.type === 'chat' && item.event.type === 'message-delta'),
      'chat delta frame',
    ) as { event: ChatEvent }
    expect(event.event.type).toBe('message-delta')

    socket.close()
  })
})
