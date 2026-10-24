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

  it('allows a call matched by a persisted rule without prompting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-approval-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const ctx = new Context()
    const settings = ctx.plugin(SettingsService, { path: join(dir, 'settings.json') })
    await settings
    const approval = ctx.plugin(ApprovalService)
    await approval
    cleanups.push(() => approval.dispose(), () => settings.dispose())

    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'exact', pattern: 'echo hi' })
    let asked = false
    ctx.on('approval/requested', () => { asked = true })

    await expect(ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'echo hi' },
      subject: { kind: 'command', value: 'echo hi' },
      summary: 'run',
    })).resolves.toBe('allow')
    expect(asked).toBe(false)

    const requested = nextRequest(ctx)
    const other = ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'echo bye' },
      subject: { kind: 'command', value: 'echo bye' },
      summary: 'run',
    })
    const request = await requested
    ctx.approval.resolve(request.id, 'deny')
    await expect(other).resolves.toBe('deny')
  })

  it('persists "always" as an exact rule and re-prompts after deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-approval-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const ctx = new Context()
    const settings = ctx.plugin(SettingsService, { path: join(dir, 'settings.json') })
    await settings
    const approval = ctx.plugin(ApprovalService)
    await approval
    cleanups.push(() => approval.dispose(), () => settings.dispose())

    const call = () => ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'echo hi' },
      subject: { kind: 'command', value: 'echo hi' },
      summary: 'run',
    })

    const requested = nextRequest(ctx)
    const pending = call()
    const request = await requested
    ctx.approval.resolve(request.id, 'always')
    await expect(pending).resolves.toBe('always')

    const [rule] = ctx.settings.approvalRules()
    expect(rule).toMatchObject({ tool: 'bash', match: 'exact', pattern: 'echo hi' })

    await expect(call()).resolves.toBe('allow')

    await ctx.settings.removeApprovalRule(rule!.id)

    const requestedAgain = nextRequest(ctx)
    const again = call()
    const second = await requestedAgain
    ctx.approval.resolve(second.id, 'deny')
    await expect(again).resolves.toBe('deny')
  })

  it('forces a prompt for dangerous commands even when bypassed and rules match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-approval-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const ctx = new Context()
    const settings = ctx.plugin(SettingsService, { path: join(dir, 'settings.json') })
    await settings
    const approval = ctx.plugin(ApprovalService)
    await approval
    cleanups.push(() => approval.dispose(), () => settings.dispose())

    await ctx.settings.update({ agent: { bypassApprovals: true } })
    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'prefix', pattern: 'git' })

    let asked = false
    ctx.on('approval/requested', () => { asked = true })

    await expect(ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'pnpm test' },
      subject: { kind: 'command', value: 'pnpm test' },
      summary: 'run',
    })).resolves.toBe('allow')
    expect(asked).toBe(false)

    const requested = nextRequest(ctx)
    const pending = ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'git push --force origin main' },
      subject: { kind: 'command', value: 'git push --force origin main' },
      summary: 'run',
    })
    const request = await requested
    expect(request.guard).toContain('强制推送')

    ctx.approval.resolve(request.id, 'always')
    await expect(pending).resolves.toBe('always')
    // "always" must not create a rule for a guarded command.
    expect(ctx.settings.approvalRules()).toHaveLength(1)

    await ctx.settings.updateApprovalGuard({ enabled: false })
    await expect(ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'git push --force origin main' },
      subject: { kind: 'command', value: 'git push --force origin main' },
      summary: 'run',
    })).resolves.toBe('allow')
  })

  it('applies deny > ask > allow and keeps ask rules under bypass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-approval-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const ctx = new Context()
    const settings = ctx.plugin(SettingsService, { path: join(dir, 'settings.json') })
    await settings
    const approval = ctx.plugin(ApprovalService)
    await approval
    cleanups.push(() => approval.dispose(), () => settings.dispose())

    const call = () => ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'pnpm test' },
      subject: { kind: 'command', value: 'pnpm test' },
      summary: 'run',
    })

    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'exact', pattern: 'pnpm test', action: 'allow' })
    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'exact', pattern: 'pnpm test', action: 'ask' })
    await ctx.settings.upsertApprovalRule({ tool: 'bash', match: 'exact', pattern: 'pnpm test', action: 'deny' })

    await expect(call()).resolves.toBe('deny')

    await ctx.settings.removeApprovalRule(
      ctx.settings.approvalRules().find(rule => rule.action === 'deny')!.id,
    )
    await ctx.settings.update({ agent: { bypassApprovals: true } })

    const requested = nextRequest(ctx)
    const pending = call()
    const request = await requested
    expect(request.guard).toContain('规则：')
    ctx.approval.resolve(request.id, 'allow')
    await expect(pending).resolves.toBe('allow')

    await ctx.settings.removeApprovalRule(
      ctx.settings.approvalRules().find(rule => rule.action === 'ask')!.id,
    )
    await ctx.settings.update({ agent: { bypassApprovals: false } })
    await expect(call()).resolves.toBe('allow')
  })
})
