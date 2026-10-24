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

  it('stores MCP servers, redacts env and preserves it on updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-settings-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.json')

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path })
    await fiber
    cleanups.push(() => fiber.dispose())

    await ctx.settings.upsertMcpServer({
      label: 'Files',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { TOKEN: 'secret' },
    })

    const publicSettings = ctx.settings.get()
    expect(publicSettings.mcp?.servers[0]).toMatchObject({
      id: 'files',
      label: 'Files',
      command: 'npx',
      envKeys: ['TOKEN'],
      hasEnv: true,
    })
    expect(JSON.stringify(publicSettings)).not.toContain('secret')

    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.mcp.servers[0].env).toEqual({ TOKEN: 'secret' })

    await ctx.settings.upsertMcpServer({ label: 'Renamed', disabled: true }, 'files')
    expect(ctx.settings.mcpServers()[0]).toMatchObject({
      label: 'Renamed',
      disabled: true,
      env: { TOKEN: 'secret' },
    })

    await ctx.settings.upsertMcpServer({ env: {} }, 'files')
    expect(ctx.settings.mcpServers()[0].env).toBeUndefined()

    await ctx.settings.removeMcpServer('files')
    expect(ctx.settings.mcpServers()).toEqual([])
  })
})
