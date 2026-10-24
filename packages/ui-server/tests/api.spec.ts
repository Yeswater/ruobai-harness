import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

async function setup() {
  const harness = await createHarness()
  harnesses.push(harness)
  return harness
}

describe('ui server', () => {
  it('serves sessions and streams a reply over the JSON API', async () => {
    const { ctx } = await setup()
    expect(ctx.web.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const listed = await (await fetch(`${ctx.web.url}/api/sessions`)).json() as { sessions: unknown[] }
    expect(listed.sessions).toHaveLength(0)

    const created = await (await fetch(`${ctx.web.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'api test' }),
    })).json() as { session: ChatSession }
    expect(created.session.title).toBe('api test')

    await fetch(`${ctx.web.url}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '看一下文件' }),
    })

    let session = created.session
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const body = await (await fetch(`${ctx.web.url}/api/sessions/${session.id}`)).json() as { session: ChatSession }
      session = body.session
      if (session.messages.length >= 3 && !session.streaming) break
    }

    expect(session.streaming).toBe(false)
    expect(session.messages.length).toBeGreaterThanOrEqual(3)
    expect(session.messages.some(message => message.blocks.some(block => block.type === 'tool'))).toBe(true)
  })

  it('exposes runtime state and an SSE stream', async () => {
    const { ctx } = await setup()

    const runtime = await (await fetch(`${ctx.web.url}/api/runtime`)).json() as {
      plugins: Array<{ name: string; state: string }>
      services: string[]
    }
    expect(runtime.plugins.some(plugin => plugin.name === 'WebServer' && plugin.state === 'ACTIVE')).toBe(true)
    expect(runtime.services).toEqual(expect.arrayContaining([
      'chat', 'sessions', 'agents', 'llm', 'tools', 'web', 'ui', 'workspace', 'settings',
    ]))

    const response = await fetch(`${ctx.web.url}/api/events`)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('connected')
    await reader.cancel()
  })

  it('rejects a second prompt while a turn is running', async () => {
    const harness = await createHarness({ delay: 30 })
    harnesses.push(harness)
    const { ctx } = harness

    const created = await (await fetch(`${ctx.web.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'busy' }),
    })).json() as { session: ChatSession }

    const send = () => fetch(`${ctx.web.url}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '写一段回复' }),
    })

    const first = await send()
    expect(first.status).toBe(201)
    const second = await send()
    expect(second.status).toBe(409)
  })
})
