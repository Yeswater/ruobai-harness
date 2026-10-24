import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function fakeModelsServer() {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer sk-test') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-a' }, { id: 'fake-b' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

describe('provider API', () => {
  it('creates, redacts, fetches models, activates and deletes providers', async () => {
    const harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url
    const baseUrl = await fakeModelsServer()

    const created = await (await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fake', baseUrl, apiKey: 'sk-test', models: ['fake-a'] }),
    })).json() as {
      settings: { llm: { activeProvider?: string; activeModel?: string; providers: Array<any> } }
    }

    const provider = created.settings.llm.providers.find(item => item.name === 'Fake')
    expect(provider).toMatchObject({ baseUrl, mode: 'direct', models: [{ id: 'fake-a' }], hasApiKey: true })
    expect(JSON.stringify(created)).not.toContain('sk-test')
    // active was mock, so the first configured provider becomes active
    expect(created.settings.llm.activeProvider).toBe(provider.id)
    expect(created.settings.llm.activeModel).toBe('fake-a')

    const stored = JSON.parse(await readFile(harness.settingsPath, 'utf8'))
    expect(stored.llm.providers.find((item: any) => item.id === provider.id).apiKey).toBe('sk-test')

    const fetched = await (await fetch(`${base}/api/providers/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, id: provider.id }),
    })).json() as { models: Array<{ id: string }> }
    expect(fetched.models).toEqual([{ id: 'fake-a' }, { id: 'fake-b' }])

    const denied = await fetch(`${base}/api/providers/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl }),
    })
    expect(denied.status).toBe(502)

    const updated = await (await fetch(`${base}/api/providers/${provider.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: ['fake-a', 'fake-b'] }),
    })).json() as { settings: { llm: { providers: Array<{ id: string; models: Array<{ id: string }> }> } } }
    expect(updated.settings.llm.providers.find(item => item.id === provider.id)?.models)
      .toEqual([{ id: 'fake-a' }, { id: 'fake-b' }])

    const activated = await (await fetch(`${base}/api/providers/${provider.id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fake-b' }),
    })).json() as { settings: { llm: { activeModel?: string } } }
    expect(activated.settings.llm.activeModel).toBe('fake-b')

    const removed = await (await fetch(`${base}/api/providers/${provider.id}`, {
      method: 'DELETE',
    })).json() as { settings: { llm: { providers: Array<{ id: string }> } } }
    expect(removed.settings.llm.providers.some(item => item.id === provider.id)).toBe(false)
  })
})
