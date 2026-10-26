import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ApprovalService from '@ruobai/approval'
import SandboxPolicyService from '@ruobai/sandbox-policy'
import DenialService from '@ruobai/sandbox-denial'
import type { Denial } from '@ruobai/sandbox-denial'
import EscalationService from '@ruobai/sandbox-escalation'

function denial(overrides: Partial<Denial> = {}): Denial {
  return {
    id: 'd1',
    runId: 'r1',
    sessionId: 's1',
    kind: 'fs-write-outside',
    target: '/Users/x/ws/notes.txt',
    evidence: 'native-log',
    confidence: 'high',
    fingerprint: 'fp1',
    repeated: 1,
    command: 'echo x > notes.txt',
    exitCode: 1,
    at: Date.now(),
    message: 'denied',
    ...overrides,
  }
}

async function setup(root = '/Users/x/ws', defaultMode: 'auto' | 'never' = 'auto') {
  const ctx = new Context()
  const approval = ctx.plugin(ApprovalService)
  await approval
  const policy = ctx.plugin(SandboxPolicyService, { root })
  await policy
  const denial = ctx.plugin(DenialService)
  await denial
  const escalation = ctx.plugin(EscalationService, { defaultMode })
  await escalation
  return {
    ctx,
    escalation: ctx.escalation,
    async dispose() {
      await escalation.dispose()
      await denial.dispose()
      await policy.dispose()
      await approval.dispose()
    },
  }
}

describe('escalation exemptions', () => {
  it('relaxes exactly the denied file, not its directory', async () => {
    const { escalation, dispose } = await setup()
    const plan = escalation.plan(denial({ target: '/Users/x/ws/notes.txt' }), 1)
    expect(plan.relaxable).toBe(true)
    // `write-root: /Users/x/ws` would hand the whole workspace to the retry.
    expect(plan.exemption).toEqual({ kind: 'write-file', path: '/Users/x/ws/notes.txt', once: true })
    await dispose()
  })

  it('refuses to relax device nodes and system directories', async () => {
    const { escalation, dispose } = await setup()
    for (const target of [
      '/dev/dtracehelper',
      '/dev/disk2',
      '/private/etc/hosts',
      '/System/Library/CoreServices',
      '/usr/bin/env',
      '/Library/LaunchDaemons/x.plist',
    ]) {
      const plan = escalation.plan(denial({ target }), 1)
      // `dirname('/dev/dtracehelper')` is `/dev`: the exact bug this guards.
      expect(plan.relaxable, target).toBe(false)
      expect(plan.exemption).toBeUndefined()
    }
    await dispose()
  })

  it('refuses paths outside the workspace and home', async () => {
    const { escalation, dispose } = await setup()
    expect(escalation.plan(denial({ target: '/opt/other/file.txt' }), 1).relaxable).toBe(false)
    await dispose()
  })

  it('still relaxes a guarded file through its guard id', async () => {
    const { escalation, dispose } = await setup()
    const plan = escalation.plan(denial({
      kind: 'fs-read-guarded',
      target: '/Users/x/ws/config.json',
      guard: 'local-secret',
    }), 1)
    expect(plan.exemption).toEqual({ kind: 'guard-read', guard: 'local-secret' })
    await dispose()
  })

  it('treats low-confidence evidence as unsafe to retry', async () => {
    const { escalation, dispose } = await setup()
    const plan = escalation.plan(denial({ confidence: 'low', command: 'cat notes.txt' }), 1)
    expect(plan.retry).toBe('unsafe')
    await dispose()
  })

  it('uses its configured default mode for sessions without a switch', async () => {
    const { escalation, dispose } = await setup('/Users/x/ws', 'never')
    expect(escalation.modeFor('s1')).toBe('never')
    expect(escalation.modeFor()).toBe('never')
    expect(escalation.setMode('s1', 'auto')).toBe('never')
    expect(escalation.modeFor('s1')).toBe('auto')
    await dispose()
  })

  it('never relaxes network denials', async () => {
    const { escalation, dispose } = await setup()
    const plan = escalation.plan(denial({ kind: 'network-outbound', target: 'remote:*:443' }), 1)
    expect(plan.relaxable).toBe(false)
    expect(plan.reason).toContain('永不放宽')
    await dispose()
  })

  it('reports low confidence in the reason without blocking the prompt', async () => {
    const { escalation, dispose } = await setup()
    const plan = escalation.plan(denial({ confidence: 'low' }), 1)
    expect(plan.relaxable).toBe(true)
    expect(plan.reason).toContain('置信度低')
    await dispose()
  })

  it('never relaxes guards that carry persistence or credentials', async () => {
    const { escalation, dispose } = await setup()
    for (const guard of ['git-hooks', 'git-config', 'harness-state']) {
      const plan = escalation.plan(denial({
        kind: 'fs-write-guarded',
        guard,
        target: '/Users/x/ws/.git/hooks/pre-commit',
        confidence: 'high',
      }), 1)
      expect(plan.relaxable).toBe(false)
      expect(plan.reason).toContain('永不放宽')
      expect(plan.exemption).toBeUndefined()
    }

    const ordinary = escalation.plan(denial({
      kind: 'fs-write-guarded',
      guard: 'project-guard',
      target: '/Users/x/ws/build/out.txt',
      confidence: 'high',
    }), 1)
    expect(ordinary.relaxable).toBe(true)
    await dispose()
  })
})
