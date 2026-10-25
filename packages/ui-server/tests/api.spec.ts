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

  it('accepts attachment-only messages and exposes them in the transcript', async () => {
    const { ctx } = await setup()
    const base = ctx.web.url
    const json = { 'Content-Type': 'application/json' }

    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'attachments' }),
    })).json() as { session: ChatSession }

    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const sent = await fetch(`${base}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        attachments: [{ kind: 'image', name: 'shot.png', mime: 'image/png', data: png }],
      }),
    })
    expect(sent.status).toBe(201)
    const message = (await sent.json() as { message: { blocks: unknown[] } }).message
    expect(message.blocks).toEqual([
      expect.objectContaining({ type: 'attachment' }),
    ])

    const loaded = await (await fetch(`${base}/api/sessions/${created.session.id}`)).json() as { session: ChatSession }
    const blocks = loaded.session.messages[0]?.blocks ?? []
    expect(blocks.some(block => block.type === 'attachment')).toBe(true)

    const invalid = await fetch(`${base}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        attachments: [{ kind: 'image', name: 'bad.gif', mime: 'image/bmp', data: png }],
      }),
    })
    expect(invalid.status).toBe(400)
  })

  it('persists the per-session model and permission preset', async () => {
    const { ctx } = await setup()
    const base = ctx.web.url
    const json = { 'Content-Type': 'application/json' }

    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'settings' }),
    })).json() as { session: ChatSession }

    const model = await fetch(`${base}/api/sessions/${created.session.id}/model`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ provider: 'mock', model: 'mock-1' }),
    })
    expect(model.status).toBe(200)

    const listed = await (await fetch(`${base}/api/models`)).json() as {
      providers: Array<{ id: string; name: string; models: Array<{ id: string }> }>
    }
    const deepseek = listed.providers.find(provider => provider.id === 'deepseek')
    expect(deepseek?.name).toBe('DeepSeek')
    expect(deepseek?.models.map(model => model.id))
      .toEqual(expect.arrayContaining(['deepseek-chat', 'deepseek-reasoner']))

    const configuredModel = await fetch(`${base}/api/sessions/${created.session.id}/model`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-reasoner' }),
    })
    expect(configuredModel.status).toBe(200)

    await fetch(`${base}/api/providers/deepseek`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({
        models: [
          { id: 'deepseek-chat', contextWindow: 128_000, inputTypes: ['text', 'image'] },
          { id: 'deepseek-reasoner', contextWindow: 128_000, maxOutputTokens: 8_000, inputTypes: ['text'] },
        ],
      }),
    })

    const context = await (await fetch(`${base}/api/sessions/${created.session.id}/context`)).json() as {
      contextWindow?: number
      compactAt?: number
    }
    expect(context.contextWindow).toBe(128_000)

    await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ agent: { compactPercent: 50 } }),
    })
    const compacted = await (await fetch(`${base}/api/sessions/${created.session.id}/context`)).json() as {
      compactAt?: number
    }
    expect(compacted.compactAt).toBe(64_000)

    const image = await fetch(`${base}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        attachments: [{
          kind: 'image',
          name: 'shot.png',
          mime: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }],
      }),
    })
    expect(image.status).toBe(400)

    const unknownModel = await fetch(`${base}/api/sessions/${created.session.id}/model`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ provider: 'nope', model: 'x' }),
    })
    expect(unknownModel.status).toBe(400)

    const unconfirmed = await fetch(`${base}/api/sessions/${created.session.id}/permission`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ mode: 'full-access' }),
    })
    expect(unconfirmed.status).toBe(400)

    const confirmed = await (await fetch(`${base}/api/sessions/${created.session.id}/permission`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ mode: 'full-access', confirm: true }),
    })).json() as { session: ChatSession }
    expect(confirmed.session.permission).toBe('full-access')

    const invalid = await fetch(`${base}/api/sessions/${created.session.id}/permission`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ mode: 'nope' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('exposes the trajectory and compacts on demand', async () => {
    const harness = await createHarness({ context: { retainTokens: 40, keepRecent: 3 } })
    harnesses.push(harness)
    const { ctx } = harness
    ctx.effect(() => ctx.llm.register({
      name: 'scripted',
      models: ['scripted-1'],
      async *stream(request) {
        const system = request.messages[0]?.role === 'system'
          ? request.messages[0].content.map(part => part.type === 'text' ? part.text : '').join('')
          : ''
        const summary = system.includes('compaction engine')
        yield { type: 'text-delta' as const, text: summary ? '## Summary\n- compacted' : 'ok' }
        yield { type: 'done' as const, reason: 'stop' as const }
      },
    }))
    await ctx.settings.update({ llm: { activeProvider: 'scripted', activeModel: 'scripted-1' } })

    const session = ctx.chat.create(undefined, 'agent')
    for (let index = 0; index < 10; index += 1) {
      ctx.sessions.append(session.id, 'message/user', {
        id: `seed-${index}`,
        text: `requirement ${index} ${'x'.repeat(300)}`,
        at: index,
      })
    }
    const base = ctx.web.url

    const before = await (await fetch(`${base}/api/sessions/${session.id}/trajectory`)).json() as {
      events: Array<{ type: string; data?: { text?: string } }>
    }
    expect(before.events.some(event => event.type === 'message/user')).toBe(true)
    expect(before.events.find(event => event.type === 'message/user')?.data?.text)
      .toContain('requirement 0')

    const compacted = await fetch(`${base}/api/sessions/${session.id}/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(compacted.status).toBe(200)
    const result = await compacted.json() as {
      compacted: boolean
      info?: { before: number; after: number }
    }
    expect(result.compacted).toBe(true)
    expect(result.info!.after).toBeLessThan(result.info!.before)

    const after = await (await fetch(`${base}/api/sessions/${session.id}/trajectory`)).json() as {
      events: Array<{ type: string; data?: { text?: string } }>
    }
    const summary = after.events.find(event => event.type === 'context/summary')
    expect(summary?.data?.text).toContain('## Summary')
  })

  it('records a context snapshot per turn and keeps later user inputs', async () => {
    const { ctx } = await setup()
    const session = ctx.chat.create(undefined, 'agent')
    const base = ctx.web.url
    const json = { 'Content-Type': 'application/json' }
    const send = (text: string) => fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ text }),
    })
    const settle = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
        const body = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as { session: ChatSession }
        if (!body.session.streaming) return
      }
      throw new Error('turn did not settle')
    }

    await send('第一轮')
    await settle()
    await send('第二轮，继续')
    await settle()

    const trajectory = await (await fetch(`${base}/api/sessions/${session.id}/trajectory`)).json() as {
      events: Array<{ type: string; data?: Record<string, unknown> }>
    }
    const turns = trajectory.events.filter(event => event.type === 'message/user')
    expect(turns.map(event => event.data?.text)).toEqual(['第一轮', '第二轮，继续'])
    const snapshots = trajectory.events.filter(event => event.type === 'context/snapshot')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]?.data).toMatchObject({ turns: 1, focus: '第一轮' })
    expect(snapshots[1]?.data).toMatchObject({ turns: 2, focus: '第二轮，继续' })
    expect(Number(snapshots[0]?.data?.messages)).toBeGreaterThan(1)
    expect(Number(snapshots[0]?.data?.estimatedTokens)).toBeGreaterThan(0)
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
