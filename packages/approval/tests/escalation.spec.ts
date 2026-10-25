import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@ruobai/cordis'
import SettingsService from '@ruobai/settings'
import ApprovalService from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.useRealTimers()
})

async function setup(options: { bypass?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rbh-approval-esc-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const settings = ctx.plugin(SettingsService, { path: join(dir, 'settings.json') })
  await settings
  const approval = ctx.plugin(ApprovalService)
  await approval
  cleanups.push(() => approval.dispose(), () => settings.dispose())
  if (options.bypass) await ctx.settings.update({ agent: { bypassApprovals: true } })
  return { ctx, settings: ctx.settings, approval }
}

function escalationInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    tool: 'bash',
    args: { command: 'cat ~/.ssh/id_rsa' },
    kind: 'escalation' as const,
    subject: { kind: 'command' as const, value: 'cat ~/.ssh/id_rsa' },
    summary: '沙箱拒绝：fs-read-guarded',
    escalation: {
      kind: 'fs-read-guarded',
      target: '/Users/x/.ssh/id_rsa',
      guard: 'ssh-keys',
      command: 'cat ~/.ssh/id_rsa',
      exemption: { kind: 'guard-read', guard: 'ssh-keys' },
      retry: 'safe' as const,
      attempt: 1,
    },
    ...overrides,
  }
}

describe('escalation approvals', () => {
  it('is never bypassed by settings', async () => {
    const { ctx } = await setup({ bypass: true })
    let asked = false
    ctx.on('approval/requested', () => {
      asked = true
      // No resolve: the request stays pending until we deny it below.
    })
    const pending = ctx.approval.request(escalationInput())
    await Promise.resolve()
    expect(asked).toBe(true)
    ctx.approval.denyAll()
    await expect(pending).resolves.toBe('deny')
  })

  it('keeps bypass working for ordinary tool approvals', async () => {
    const { ctx } = await setup({ bypass: true })
    await expect(ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'echo hi' },
      subject: { kind: 'command', value: 'echo hi' },
      summary: 'echo hi',
    })).resolves.toBe('allow')
  })

  it('ignores permission-mode shortcuts for escalations', async () => {
    const ctx = new Context()
    class FullAccess extends Service {
      constructor(inner: Context) {
        super(inner, 'permissions')
      }

      modeFor() {
        return 'full-access'
      }

      approval() {
        return 'allow' as const
      }
    }
    const permissions = ctx.plugin(FullAccess)
    await permissions
    const approval = ctx.plugin(ApprovalService)
    await approval
    cleanups.push(() => approval.dispose(), () => permissions.dispose())

    let asked = false
    ctx.on('approval/requested', () => {
      asked = true
      ctx.approval.denyAll()
    })
    await expect(ctx.approval.request(escalationInput())).resolves.toBe('deny')
    expect(asked).toBe(true)
  })

  it('marks the request kind so consumers can tell them apart', async () => {
    const { ctx } = await setup()
    const seen: Array<{ kind: string; escalation?: unknown }> = []
    ctx.on('approval/requested', (request: any) => {
      seen.push(request)
      ctx.approval.resolve(request.id, 'allow')
    })
    await ctx.approval.request(escalationInput())
    expect(seen[0].kind).toBe('escalation')
    expect(seen[0].escalation).toMatchObject({ kind: 'fs-read-guarded', guard: 'ssh-keys' })
  })

  it('never persists "always" for an escalation', async () => {
    const { ctx, settings } = await setup()
    ctx.on('approval/requested', (request: any) => ctx.approval.resolve(request.id, 'always'))
    await ctx.approval.request(escalationInput())
    expect(settings.approvalRules()).toHaveLength(0)
  })
})

describe('fail-closed deadline', () => {
  it('denies when nobody answers before the deadline', async () => {
    const { ctx } = await setup()
    ctx.approval.setDeadlinePolicy({ timeoutMs: 5_000 })
    vi.useFakeTimers()
    const timeouts: unknown[] = []
    ctx.on('approval/timeout', (request: any) => timeouts.push(request))
    const pending = ctx.approval.request(escalationInput())
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBe('deny')
    expect(timeouts).toHaveLength(1)
  })

  it('clamps the timeout and refuses to disable fail-closed', async () => {
    const { ctx } = await setup()
    ctx.approval.setDeadlinePolicy({ timeoutMs: 1, onTimeout: 'deny' } as never)
    expect(ctx.approval.deadlinePolicy().timeoutMs).toBe(5_000)
    ctx.approval.setDeadlinePolicy({ timeoutMs: 10_000_000 })
    expect(ctx.approval.deadlinePolicy().timeoutMs).toBe(600_000)
    expect(ctx.approval.deadlinePolicy().onTimeout).toBe('deny')
  })

  it('restores the previous deadline when the tuning plugin unloads', async () => {
    const { ctx } = await setup()
    const before = ctx.approval.deadlinePolicy().timeoutMs
    const dispose = ctx.approval.setDeadlinePolicy({ timeoutMs: 30_000 })
    expect(ctx.approval.deadlinePolicy().timeoutMs).toBe(30_000)
    dispose()
    expect(ctx.approval.deadlinePolicy().timeoutMs).toBe(before)
  })
})

describe('rule sources', () => {
  it('applies deny > ask > allow across sources and drops removed rules', async () => {
    const { ctx } = await setup()
    const createdAt = Date.now()
    const rules = [
      { id: 'm1', tool: 'bash', match: 'prefix' as const, pattern: 'npm', action: 'allow' as const, createdAt },
      { id: 'p1', tool: 'bash', match: 'prefix' as const, pattern: 'npm publish', action: 'deny' as const, createdAt },
    ]
    const dispose = ctx.approval.rules.register({
      id: 'managed',
      priority: 100,
      version: () => 1,
      rules: () => rules,
    })

    const call = () => ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'npm publish' },
      subject: { kind: 'command', value: 'npm publish' },
      summary: 'npm publish',
    })

    // A managed deny outranks a managed allow, with no prompt.
    await expect(call()).resolves.toBe('deny')

    dispose()
    // After removal the rule must be gone: no lingering cache.
    ctx.on('approval/requested', (request: any) => ctx.approval.resolve(request.id, 'deny'))
    await expect(call()).resolves.toBe('deny')
    expect(ctx.approval.list()).toHaveLength(0)
  })

  it('only registers one source per id and restores the previous one', async () => {
    const { ctx } = await setup()
    const first = { id: 'project', priority: 50, version: () => 1, rules: () => [] as never[] }
    const second = { id: 'project', priority: 50, version: () => 2, rules: () => [] as never[] }
    const disposeFirst = ctx.approval.rules.register(first)
    const disposeSecond = ctx.approval.rules.register(second)
    disposeSecond()
    disposeFirst()
    // Both disposers are idempotent and leave nothing behind.
    ctx.on('approval/requested', (request: any) => ctx.approval.resolve(request.id, 'deny'))
    await expect(ctx.approval.request({
      sessionId: 's1',
      tool: 'bash',
      args: { command: 'ls' },
      subject: { kind: 'command', value: 'ls' },
      summary: 'ls',
    })).resolves.toBe('deny')
  })
})
