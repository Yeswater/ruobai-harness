import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
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

  it('renames, forks and deletes sessions', async () => {
    const { ctx } = await setup()
    const base = ctx.web.url
    const json = { 'Content-Type': 'application/json' }

    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'keep' }),
    })).json() as { session: ChatSession }

    await fetch(`${base}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ text: '看一下文件' }),
    })

    let session = created.session
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const body = await (await fetch(`${base}/api/sessions/${created.session.id}`)).json() as { session: ChatSession }
      session = body.session
      if (!session.streaming && session.messages.length >= 3) break
    }

    const renamed = await (await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ title: 'Renamed' }),
    })).json() as { session: ChatSession }
    expect(renamed.session.title).toBe('Renamed')

    const blank = await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ title: '   ' }),
    })
    expect(blank.status).toBe(400)

    const forked = await (await fetch(`${base}/api/sessions/${created.session.id}/fork`, {
      method: 'POST',
      headers: json,
      body: '{}',
    })).json() as { session: ChatSession }
    expect(forked.session.id).not.toBe(created.session.id)
    expect(forked.session.title).toBe('Renamed (fork)')
    expect(forked.session.messages).toHaveLength(session.messages.length)

    const deletedEvent = new Promise<string>((resolve) => {
      const off = ctx.on('chat/event', (event) => {
        if (event.type !== 'session-deleted') return
        off()
        resolve(event.sessionId)
      })
    })

    const removed = await fetch(`${base}/api/sessions/${forked.session.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    await expect(deletedEvent).resolves.toBe(forked.session.id)

    const listed = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ id: string }> }
    expect(listed.sessions.some(item => item.id === forked.session.id)).toBe(false)
    expect(listed.sessions.some(item => item.id === created.session.id)).toBe(true)

    const missing = await fetch(`${base}/api/sessions/${forked.session.id}`, { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })

  it('archives and restores a session without deleting it', async () => {
    const { ctx } = await setup()
    const base = ctx.web.url
    const json = { 'Content-Type': 'application/json' }

    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'archive me' }),
    })).json() as { session: ChatSession }

    const archived = await (await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ archived: true }),
    })).json() as { session: ChatSession }
    expect(archived.session.archived).toBe(true)

    const listed = await (await fetch(`${base}/api/sessions`)).json() as {
      sessions: Array<{ id: string; archived?: boolean }>
    }
    expect(listed.sessions.find(item => item.id === created.session.id)?.archived).toBe(true)

    const restored = await (await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ archived: false }),
    })).json() as { session: ChatSession }
    expect(restored.session.archived).toBe(false)
    expect(restored.session.title).toBe('archive me')

    const invalid = await fetch(`${base}/api/sessions/${created.session.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ archived: 'yes' }),
    })
    expect(invalid.status).toBe(400)
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

    const forked = await fetch(`${ctx.web.url}/api/sessions/${created.session.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(forked.status).toBe(409)
  })

  it('creates a session bound to a workspace and rejects invalid roots', async () => {
    const { ctx } = await setup()
    const workspace = await mkdtemp(join(tmpdir(), 'rbh-api-ws-'))
    dirs.push(workspace)

    const created = await fetch(`${ctx.web.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'workspace session', workspace }),
    })
    expect(created.status).toBe(201)
    const body = await created.json() as { session: ChatSession }
    expect(body.session.workspace).toBe(workspace)

    const relative = await fetch(`${ctx.web.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: 'relative/path' }),
    })
    expect(relative.status).toBe(400)

    const missing = await fetch(`${ctx.web.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: join(workspace, 'missing') }),
    })
    expect(missing.status).toBe(400)
  })
})
