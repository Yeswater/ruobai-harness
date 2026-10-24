import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SettingsService from '@ruobai/settings'
import ApprovalService from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function nextRequest(ctx: Context) {
  return new Promise<any>((resolve) => {
    ctx.once('approval/requested', resolve)
  })
}

describe('approval service', () => {
  it('waits for a decision and remembers "always" per session and tool', async () => {
    const ctx = new Context()
    const approval = ctx.plugin(ApprovalService)
    await approval
    cleanups.push(() => approval.dispose())

    const requested1 = nextRequest(ctx)
    const pending = ctx.approval.request({ sessionId: 's1', tool: 'write_file', args: {}, summary: 'write' })
    const request = await requested1
    expect(ctx.approval.list('s1')).toHaveLength(1)
    ctx.approval.resolve(request.id, 'always')
    await expect(pending).resolves.toBe('always')

    await expect(ctx.approval.request({
      sessionId: 's1', tool: 'write_file', args: {}, summary: 'write',
    })).resolves.toBe('allow')

    const requested2 = nextRequest(ctx)
    const other = ctx.approval.request({ sessionId: 's2', tool: 'write_file', args: {}, summary: 'write' })
    const second = await requested2
    ctx.approval.resolve(second.id, 'deny')
    await expect(other).resolves.toBe('deny')
  })

  it('denies on abort and when settings bypass approvals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-approval-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const ctx = new Context()
    const settings = ctx.plugin(SettingsService, { path: join(dir, 'settings.json') })
    await settings
    const approval = ctx.plugin(ApprovalService)
    await approval
    cleanups.push(() => approval.dispose(), () => settings.dispose())

    const controller = new AbortController()
    const requested = nextRequest(ctx)
    const pending = ctx.approval.request({
      sessionId: 's1', tool: 'edit_file', args: {}, summary: 'edit',
    }, { signal: controller.signal })
    await requested
    controller.abort()
    await expect(pending).resolves.toBe('deny')

    await ctx.settings.update({ agent: { bypassApprovals: true } })
    await expect(ctx.approval.request({
      sessionId: 's1', tool: 'write_file', args: {}, summary: 'write',
    })).resolves.toBe('allow')
  })
})
