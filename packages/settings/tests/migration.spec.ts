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

  it('seeds, persists and validates approval rules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-settings-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.json')

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path })
    await fiber
    cleanups.push(() => fiber.dispose())

    expect(ctx.settings.get().approval).toEqual({ rules: [], guard: { enabled: true } })

    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'prefix', pattern: 'pnpm test', note: 'tests' })
    const [rule] = ctx.settings.approvalRules()
    expect(rule).toMatchObject({ tool: 'bash', match: 'prefix', pattern: 'pnpm test', action: 'allow', note: 'tests' })

    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'prefix', pattern: 'pnpm test' })
    expect(ctx.settings.approvalRules()).toHaveLength(1)

    await ctx.settings.upsertApprovalRule({ pattern: 'pnpm test --watch' }, rule!.id)
    expect(ctx.settings.approvalRules()[0]!.pattern).toBe('pnpm test --watch')

    await expect(ctx.settings.upsertApprovalRule({
      tool: 'bash', match: 'prefix', pattern: 'pnpm test && rm -rf /',
    })).rejects.toThrow(/shell operators/)
    await expect(ctx.settings.upsertApprovalRule({
      tool: 'write_file', match: 'glob', pattern: '../**',
    })).rejects.toThrow(/relative workspace paths/)
    await expect(ctx.settings.upsertApprovalRule({}, 'missing')).rejects.toThrow(/unknown approval rule/)
    await expect(ctx.settings.upsertApprovalRule({
      tool: 'bash', match: 'exact', pattern: 'ls', action: 'sometimes' as never,
    })).rejects.toThrow(/approval action/)
    await expect(ctx.settings.upsertApprovalRule({
      tool: 'bash', match: 'sometimes' as never, pattern: 'ls',
    })).rejects.toThrow(/approval match/)

    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.approval.rules).toHaveLength(1)

    await ctx.settings.removeApprovalRule(rule!.id)
    expect(ctx.settings.approvalRules()).toEqual([])

    await ctx.settings.updateApprovalGuard({ enabled: false })
    expect(ctx.settings.approvalGuard()).toEqual({ enabled: false })
  })

  it('migrates legacy guard extras into ask rules and defaults rule actions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-settings-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({
      approval: {
        guard: { enabled: true, extra: ['docker compose down -v', '  '] },
        rules: [{ id: 'keep', tool: 'bash', match: 'exact', pattern: 'pnpm test', createdAt: 1 }],
      },
    }))

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path })
    await fiber
    cleanups.push(() => fiber.dispose())

    const rules = ctx.settings.approvalRules()
    expect(rules.find(rule => rule.id === 'keep')).toMatchObject({ action: 'allow' })
    expect(rules.find(rule => rule.action === 'ask')).toMatchObject({
      tool: 'bash',
      match: 'contains',
      pattern: 'docker compose down -v',
    })
    expect(ctx.settings.approvalGuard()).toEqual({ enabled: true })

    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.approval.guard.extra).toBeUndefined()
  })

  it('collapses a rule edited into an existing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-settings-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path: join(dir, 'settings.json') })
    await fiber
    cleanups.push(() => fiber.dispose())

    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'exact', pattern: 'ls' })
    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'exact', pattern: 'pwd' })
    const pwd = ctx.settings.approvalRules().find(rule => rule.pattern === 'pwd')!

    await ctx.settings.upsertApprovalRule({ pattern: 'ls' }, pwd.id)
    expect(ctx.settings.approvalRules()).toHaveLength(1)
    expect(ctx.settings.approvalRules()[0]!.pattern).toBe('ls')
  })

  it('drops malformed approval rules on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-settings-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({
      approval: {
        rules: [
          { id: 'keep', tool: 'bash', match: 'exact', pattern: 'ls', createdAt: 1 },
          { id: 'bad-match', tool: 'bash', match: 'sometimes', pattern: 'ls' },
          { tool: 'bash', match: 'exact', pattern: 'ls' },
          'nope',
        ],
      },
    }))

    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path })
    await fiber
    cleanups.push(() => fiber.dispose())

    expect(ctx.settings.approvalRules()).toEqual([
      { id: 'keep', tool: 'bash', match: 'exact', pattern: 'ls', action: 'allow', createdAt: 1 },
    ])
  })
})
