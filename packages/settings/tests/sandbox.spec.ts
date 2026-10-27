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

describe('sandbox setting', () => {
  it('defaults to enabled and persists an explicit switch-off', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-sandbox-setting-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'settings.json')
    const ctx = new Context()
    const fiber = ctx.plugin(SettingsService, { path })
    await fiber
    cleanups.push(() => fiber.dispose())

    expect(ctx.settings.sandboxEnabled()).toBe(true)

    await ctx.settings.update({ sandbox: { enabled: false } })
    expect(ctx.settings.sandboxEnabled()).toBe(false)
    expect(ctx.settings.get().sandbox).toEqual({ enabled: false })
    expect(JSON.parse(await readFile(path, 'utf8')).sandbox).toEqual({ enabled: false })

    await ctx.settings.update({ sandbox: { enabled: true } })
    expect(ctx.settings.sandboxEnabled()).toBe(true)
  })
})
