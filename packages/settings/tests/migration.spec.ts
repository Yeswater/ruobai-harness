import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SettingsService from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('settings migration', () => {
  it('converts the legacy single-provider shape and persists it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-settings-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({
      llm: { provider: 'openai', model: 'deepseek-flash', apiKey: 'sk-legacy' },
    }))

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path })
    await fiber
    cleanups.push(() => fiber.dispose())

    const settings = ctx.settings.get()
    const provider = settings.llm?.providers[0]
    expect(provider).toMatchObject({
      id: 'openai',
      name: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      hasApiKey: true,
      models: [{ id: 'deepseek-flash' }],
    })
    expect(settings.llm?.activeProvider).toBe('openai')
    expect(settings.llm?.activeModel).toBe('deepseek-flash')

    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.llm.provider).toBeUndefined()
    expect(stored.llm.apiKey).toBeUndefined()
    expect(stored.llm.providers[0].apiKey).toBe('sk-legacy')
  })

  it('seeds DeepSeek and lets env keys satisfy it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-settings-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path: join(dir, 'settings.json') })
    await fiber
    cleanups.push(() => fiber.dispose())

    const provider = ctx.settings.get().llm?.providers[0]
    expect(provider).toMatchObject({ id: 'deepseek', name: 'DeepSeek' })
  })
})
