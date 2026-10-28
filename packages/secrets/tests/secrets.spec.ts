import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SecretsService from '@ruobai/secrets'
import SettingsService from '@ruobai/settings'

const cleanups: Array<() => Promise<void>> = []
const ENV_KEYS = ['RBU_API_KEY', 'DEEPSEEK_API_KEY', 'GITEE_TOKEN', 'RBU_BASE_URL'] as const
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  // The developer shell may carry real keys; the fallback order must not leak
  // into assertions about stored values.
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

async function setup(options: { provider: 'file' | 'keychain'; service?: string } = { provider: 'file' }) {
  const root = await mkdtemp(join(tmpdir(), 'rbh-secrets-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  const ctx = new Context()
  const settings = ctx.plugin(SettingsService, { path: join(root, 'settings.json') })
  await settings
  cleanups.push(() => settings.dispose())

  const secrets = ctx.plugin(SecretsService, {
    provider: options.provider,
    path: join(root, 'secrets.json'),
    ...(options.service ? { service: options.service } : {}),
  })
  await secrets
  cleanups.push(() => secrets.dispose())

  return { ctx, root }
}

describe('secrets', () => {
  it('moves plaintext provider keys out of settings.json without losing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-secrets-migrate-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))

    const ctx = new Context()
    const settings = ctx.plugin(SettingsService, { path: join(root, 'settings.json') })
    await settings
    cleanups.push(() => settings.dispose())

    const before = await ctx.settings.upsertProvider({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-plaintext',
      models: ['deepseek-chat'],
    })
    const id = before.llm!.providers!.find(item => (item as { hasApiKey?: boolean }).hasApiKey)!.id
    const rawBefore = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    expect(rawBefore.llm.providers.find((item: { id: string }) => item.id === id).apiKey)
      .toBe('sk-plaintext')

    const secrets = ctx.plugin(SecretsService, { provider: 'file', path: join(root, 'secrets.json') })
    await secrets
    cleanups.push(() => secrets.dispose())

    const stored = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    expect(stored.llm.providers.find((item: { id: string }) => item.id === id).apiKey).toBeUndefined()
    expect(ctx.settings.apiKeyFor(id)).toBe('sk-plaintext')
    expect(ctx.secrets.backend).toBe('file')

    const secretFile = join(root, 'secrets.json')
    expect(await readFile(secretFile, 'utf8')).toContain('sk-plaintext')
    expect((await stat(secretFile)).mode & 0o777).toBe(0o600)
  })

  it('writes new keys through the store and keeps the public view masked', async () => {
    const { ctx, root } = await setup()

    const settings = await ctx.settings.upsertProvider({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-new',
      models: ['gpt-4.1'],
    })
    const entry = settings.llm!.providers!.find(item => item.name === 'OpenAI')!
    const id = entry.id

    expect(entry).not.toHaveProperty('apiKey')
    expect((entry as { hasApiKey?: boolean }).hasApiKey).toBe(true)
    expect(ctx.settings.apiKeyFor(id)).toBe('sk-new')

    const raw = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    expect(JSON.stringify(raw)).not.toContain('sk-new')
    expect(ctx.secrets.keys()).toContain(`llm/${id}`)

    await ctx.settings.removeProvider(id)
    expect(ctx.secrets.has(`llm/${id}`)).toBe(false)
  })

  it('clears and replaces a key without leaving the old one behind', async () => {
    const { ctx } = await setup()
    const created = await ctx.settings.upsertProvider({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-first',
      models: ['deepseek-chat'],
    })
    const id = created.llm!.providers![0]!.id

    await ctx.settings.upsertProvider({ apiKey: 'sk-second' }, id)
    expect(ctx.settings.apiKeyFor(id)).toBe('sk-second')

    await ctx.settings.upsertProvider({ apiKey: '' }, id)
    expect(ctx.settings.apiKeyFor(id)).toBeUndefined()
    expect(ctx.secrets.has(`llm/${id}`)).toBe(false)
  })

  it('moves the Gitee token and clears it on request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-secrets-gitee-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))

    const ctx = new Context()
    const settings = ctx.plugin(SettingsService, { path: join(root, 'settings.json') })
    await settings
    cleanups.push(() => settings.dispose())
    await ctx.settings.updateGitee({ token: 'gitee-plain' })
    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).gitee.token).toBe('gitee-plain')

    const secrets = ctx.plugin(SecretsService, { provider: 'file', path: join(root, 'secrets.json') })
    await secrets
    cleanups.push(() => secrets.dispose())

    expect(ctx.settings.giteeToken()).toBe('gitee-plain')
    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).gitee?.token).toBeUndefined()

    await ctx.settings.updateGitee({ clearToken: true })
    expect(ctx.settings.giteeToken()).toBeUndefined()
  })

  it('keeps settings working when the plugin is not mounted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-secrets-absent-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))

    const ctx = new Context()
    const settings = ctx.plugin(SettingsService, { path: join(root, 'settings.json') })
    await settings
    cleanups.push(() => settings.dispose())

    const created = await ctx.settings.upsertProvider({
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'plain-fallback',
      models: ['qwen3'],
    })
    const id = created.llm!.providers!.find(item => item.name === 'Local')!.id
    expect(ctx.settings.apiKeyFor(id)).toBe('plain-fallback')
    const raw = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    expect(raw.llm.providers.find((item: { id: string }) => item.id === id).apiKey)
      .toBe('plain-fallback')
  })
})

describe.runIf(process.platform === 'darwin')('secrets: macOS keychain', () => {
  it('round-trips a value through security(1) and removes it', async () => {
    const service = `rbu-test-${process.pid}-${Date.now()}`
    const { ctx } = await setup({ provider: 'keychain', service })
    expect(ctx.secrets.backend).toBe('keychain')

    await ctx.secrets.set('probe/token', 'value-123')
    expect(ctx.secrets.get('probe/token')).toBe('value-123')

    await ctx.secrets.delete('probe/token')
    expect(ctx.secrets.has('probe/token')).toBe(false)

    // Re-loading a fresh index must not resurrect the deleted item.
    const again = await ctx.secrets.keys()
    expect(again).not.toContain('probe/token')
  })
})
