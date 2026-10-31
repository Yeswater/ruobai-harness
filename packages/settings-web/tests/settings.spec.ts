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
      body: JSON.stringify({
        name: 'Fake',
        baseUrl,
        apiKey: 'sk-test',
        models: [{
          id: 'fake-a',
          name: 'Fake A',
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          inputTypes: ['text', 'image'],
        }],
      }),
    })).json() as {
      settings: { llm: { activeProvider?: string; activeModel?: string; providers: Array<any> } }
    }

    const provider = created.settings.llm.providers.find(item => item.name === 'Fake')
    expect(provider).toMatchObject({
      baseUrl,
      mode: 'direct',
      models: [{
        id: 'fake-a',
        name: 'Fake A',
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        inputTypes: ['text', 'image'],
      }],
      hasApiKey: true,
    })
    expect(JSON.stringify(created)).not.toContain('sk-test')
    // active was mock, so the first configured provider becomes active
    expect(created.settings.llm.activeProvider).toBe(provider.id)
    expect(created.settings.llm.activeModel).toBe('fake-a')

    // The key lives in the secret store, never in settings.json.
    const stored = JSON.parse(await readFile(harness.settingsPath, 'utf8'))
    expect(stored.llm.providers.find((item: any) => item.id === provider.id).apiKey).toBeUndefined()
    const secrets = JSON.parse(await readFile(harness.secretsPath, 'utf8'))
    expect(secrets[`llm/${provider.id}`]).toBe('sk-test')

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

  it('connects a preset from just a key after the last provider was removed', async () => {
    const harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url
    const json = { 'Content-Type': 'application/json' }

    // The harness switches to mock for offline tests; start from the seeded
    // provider so deleting it leaves nothing active.
    await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ llm: { activeProvider: 'deepseek', activeModel: 'deepseek-chat' } }),
    })

    const deleted = await (await fetch(`${base}/api/providers/deepseek`, { method: 'DELETE' })).json() as {
      settings: { llm: { activeProvider?: string; providers: Array<{ id: string }> } }
    }
    expect(deleted.settings.llm.providers).toEqual([])
    expect(deleted.settings.llm.activeProvider).toBeUndefined()

    const created = await (await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ preset: 'moonshot', apiKey: 'sk-test' }),
    })).json() as {
      settings: {
        llm: {
          activeProvider?: string
          activeModel?: string
          providers: Array<{
            id: string
            preset?: string
            baseUrl: string
            hasApiKey: boolean
            models: Array<{ id: string; contextWindow?: number }>
          }>
        }
      }
    }

    const provider = created.settings.llm.providers[0]
    expect(provider).toMatchObject({
      id: 'moonshot',
      preset: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      hasApiKey: true,
    })
    expect(provider.models[0]).toMatchObject({ id: 'kimi-k2.6', contextWindow: 262_144 })
    expect(created.settings.llm.activeProvider).toBe('moonshot')
    expect(created.settings.llm.activeModel).toBe('kimi-k2.6')
  })

  it('stores the command prefix and rejects an unknown one', async () => {
    const harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url
    const json = { 'Content-Type': 'application/json' }

    const saved = await (await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ agent: { commandPrefix: '#', compactPercent: 80 } }),
    })).json() as { settings: { agent?: { commandPrefix?: string; compactPercent?: number } } }
    expect(saved.settings.agent?.commandPrefix).toBe('#')
    expect(saved.settings.agent?.compactPercent).toBe(80)

    const invalid = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ agent: { commandPrefix: '~' } }),
    })
    expect(invalid.status).toBe(400)

    const invalidPercent = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ agent: { compactPercent: 0 } }),
    })
    expect(invalidPercent.status).toBe(400)
  })

  it('accepts full access as the default permission and rejects unknowns', async () => {
    const harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url
    const json = { 'Content-Type': 'application/json' }

    const saved = await (await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ agent: { defaultPermission: 'full-access' } }),
    })).json() as { settings: { agent?: { defaultPermission?: string } } }
    expect(saved.settings.agent?.defaultPermission).toBe('full-access')

    const invalid = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ agent: { defaultPermission: 'everything' } }),
    })
    expect(invalid.status).toBe(400)
  })
})

describe('provider presets', () => {
  it('serves presets and explains a rejected key', async () => {
    const harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url

    const { presets } = await (await fetch(`${base}/api/providers/presets`)).json() as {
      presets: Array<{ id: string; name: string; baseUrl: string }>
    }
    expect(presets.map(preset => preset.id)).toContain('deepseek')
    for (const preset of presets) expect(preset.baseUrl.startsWith('http')).toBe(true)

    const baseUrl = await fakeModelsServer()
    const response = await fetch(`${base}/api/providers/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl }),
    })
    expect(response.status).toBe(502)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('密钥无效或没有权限')
  })
})
