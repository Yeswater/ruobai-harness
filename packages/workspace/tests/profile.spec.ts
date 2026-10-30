import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('environment profile', () => {
  it('resolves the session-pinned profile before the active one', async () => {
    harness = await createHarness()
    const { ctx } = harness

    await ctx.settings.update({
      profiles: [
        { id: 'a', label: '客户 A', workspace: { root: '/tmp/profile-a' } },
        { id: 'b', label: '客户 B', workspace: { root: '/tmp/profile-b' } },
      ],
      activeProfile: 'b',
    })

    const pinned = ctx.sessions.create({ workspace: '/tmp/session', profile: 'a' })
    expect(ctx.workspace.rootFor(pinned.id)).toBe('/tmp/profile-a')

    // No profile pinned: the active one decides, not the session workspace.
    const active = ctx.sessions.create({ workspace: '/tmp/session' })
    expect(ctx.workspace.rootFor(active.id)).toBe('/tmp/profile-b')
  })

  it('falls back to the session workspace when nothing matches', async () => {
    harness = await createHarness()
    const { ctx } = harness
    const meta = ctx.sessions.create({ workspace: '/tmp/session' })
    expect(ctx.workspace.rootFor(meta.id)).toBe('/tmp/session')
  })

  it('ignores a profile id that no longer exists', async () => {
    harness = await createHarness()
    const { ctx } = harness
    await ctx.settings.update({ profiles: [], activeProfile: '' })
    const meta = ctx.sessions.create({ workspace: '/tmp/session', profile: 'gone' })
    expect(ctx.workspace.rootFor(meta.id)).toBe('/tmp/session')
  })
})
