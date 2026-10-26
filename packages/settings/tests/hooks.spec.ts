import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SettingsService from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('hook settings', () => {
  it('merges, clamps and persists the hook section', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-hooks-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.json')
    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path })
    await fiber
    cleanups.push(() => fiber.dispose())

    await ctx.settings.updateHooks({
      edit: { enabled: false, timeoutMs: 5, maxDiagnostics: 999 },
      stop: { failure: 'close', maxRounds: 9 },
      guard: {
        denyWrite: [' .env ', '.env', 42 as unknown as string],
        denyCommand: ['git push --force'],
      },
      audit: { enabled: true, trigger: 'stop', dailyBudget: 99_999, prompt: 'x'.repeat(5000) },
    })

    const hooks = ctx.settings.get().hooks!
    expect(hooks.edit).toMatchObject({ enabled: false, timeoutMs: 100, maxDiagnostics: 100 })
    expect(hooks.stop).toMatchObject({ failure: 'close', maxRounds: 5 })
    expect(hooks.guard?.denyWrite).toEqual(['.env'])
    expect(hooks.guard?.denyCommand).toEqual(['git push --force'])
    expect(hooks.audit).toMatchObject({ enabled: true, trigger: 'stop', dailyBudget: 10_000 })
    expect(hooks.audit?.prompt?.length).toBe(4000)

    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.hooks.stop.failure).toBe('close')

    await ctx.settings.updateHooks({ edit: { enabled: true } })
    expect(ctx.settings.get().hooks?.edit).toMatchObject({ enabled: true, timeoutMs: 100 })
  })
})
