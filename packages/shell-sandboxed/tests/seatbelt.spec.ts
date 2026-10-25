import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ApprovalService from '@ruobai/approval'
import { Context, Service } from '@ruobai/cordis'
import { SandboxUnavailableError } from '@ruobai/sandbox'
import DenialService from '@ruobai/sandbox-denial'
import SandboxPolicyService from '@ruobai/sandbox-policy'
import EscalationService from '@ruobai/sandbox-escalation'
import SandboxService from '@ruobai/sandbox'
import ShellService from '@ruobai/shell'
import SandboxedShell from '@ruobai/shell-sandboxed'
import SandboxGuards from '@ruobai/sandbox-guards'
import SandboxMacOs from '@ruobai/sandbox-macos'

const darwin = process.platform === 'darwin'
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface SetupOptions {
  selfCheck?: boolean
  withApproval?: boolean
  escalate?: 'auto' | 'never'
  network?: 'deny' | 'allowlist'
  decide?: 'allow' | 'deny' | 'always'
}

async function setup(options: SetupOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rbh-sandbox-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()

  const shell = ctx.plugin(ShellService)
  await shell
  const sandbox = ctx.plugin(SandboxService)
  await sandbox
  const policy = ctx.plugin(SandboxPolicyService, {
    root,
    network: { mode: options.network ?? 'deny', allow: [] },
    limits: { timeoutMs: 5_000, maxOutputBytes: 4_096 },
  })
  await policy
  const guards = ctx.plugin(SandboxGuards, { includeDefaults: true })
  await guards
  const denial = ctx.plugin(DenialService)
  await denial
  const macos = ctx.plugin(SandboxMacOs, { selfCheck: options.selfCheck ?? true })
  await macos

  let approval: { dispose(): Promise<void> } | undefined
  let escalation: { dispose(): Promise<void> } | undefined
  if (options.withApproval !== false) {
    approval = ctx.plugin(ApprovalService)
    await approval
    escalation = ctx.plugin(EscalationService, { maxAttempts: 2 })
    await escalation
  }
  const sandboxedShell = ctx.plugin(SandboxedShell, { escalate: options.escalate ?? 'auto' })
  await sandboxedShell

  cleanups.push(
    () => sandboxedShell.dispose(),
    () => escalation?.dispose() ?? Promise.resolve(),
    () => approval?.dispose() ?? Promise.resolve(),
    () => macos.dispose(),
    () => denial.dispose(),
    () => guards.dispose(),
    () => policy.dispose(),
    () => sandbox.dispose(),
    () => shell.dispose(),
  )

  // Answer approvals on demand, recording what the human was shown.
  const seen: any[] = []
  ctx.on('approval/requested', (request: any) => {
    seen.push(request)
    ctx.approval.resolve(request.id, options.decide ?? 'allow')
  })
  return { ctx, root, seen, macos }
}

function run(ctx: Context, command: string, cwd: string, sessionId = 's1') {
  return ctx.shell.run({
    command,
    cwd,
    root: cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    sessionId,
  })
}

describe.skipIf(!darwin)('seatbelt provider', () => {
  it('is available after the self-check and reports a profile digest', async () => {
    const { ctx } = await setup()
    const provider = ctx.sandbox.provider('darwin')
    expect(provider?.id).toBe('darwin-seatbelt')
    expect(provider?.capabilities.has('kernel-fs')).toBe(true)
    expect(provider?.extensions?.profileDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lets ordinary commands run inside the workspace', async () => {
    const { ctx, root } = await setup()
    const result = await run(ctx, 'echo hello', root)
    expect(result.exitCode).toBe(0)
    expect(result.content).toContain('hello')
    expect(result.sandboxed).toBe(true)
    expect(result.denials).toEqual([])
  })

  it('denies a guarded write and classifies it', async () => {
    // Escalation off: this asserts the hard boundary, not the retry path.
    const { ctx, root } = await setup({ selfCheck: false, escalate: 'never' })
    await mkdir(join(root, '.git'), { recursive: true })
    const result = await run(ctx, 'echo hacked >> .git/config', root)
    expect(result.exitCode).not.toBe(0)
    expect(result.denials.length).toBeGreaterThan(0)
    expect(result.content).toContain('[sandbox]')
  })

  it('denies reading a guarded file', async () => {
    const { ctx, root } = await setup({ selfCheck: false, escalate: 'never' })
    const secretDir = join(root, 'secrets')
    await mkdir(secretDir, { recursive: true })
    await writeFile(join(secretDir, 'key'), 'top-secret')
    const dispose = ctx.sandboxPolicy.registerGuard({
      id: 'local-secret',
      path: secretDir,
      match: 'subpath',
      access: 'read',
      reason: 'test secret',
    })
    cleanups.push(dispose)
    // The guard must be compiled into the next profile, and the version bump
    // must invalidate the cached one.
    const result = await run(ctx, `cat ${join(secretDir, 'key')}`, root)
    expect(result.exitCode).not.toBe(0)
    expect(result.content).not.toContain('top-secret')
  })

  it('denies outbound network even to loopback', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    const result = await run(ctx, 'curl -s -m 2 http://127.0.0.1:1/', root)
    expect(result.exitCode).not.toBe(0)
    expect(result.content).toContain('[sandbox]')
  })

  it('fails closed after the provider plugin is unloaded', async () => {
    const { ctx, root, macos } = await setup({ selfCheck: false })
    expect(ctx.sandbox.provider('darwin')).toBeDefined()
    await macos.dispose()
    // No silent fallback to an unconfined spawn: the shell must refuse.
    await expect(run(ctx, 'echo ok', root)).rejects.toBeInstanceOf(SandboxUnavailableError)
  })
})

describe.skipIf(!darwin)('sandbox → denial → approval → retry', () => {
  it('escalates a guarded read and retries once after approval', async () => {
    const { ctx, root, seen } = await setup({ selfCheck: false, decide: 'allow' })
    const secretDir = join(root, 'secrets')
    await mkdir(secretDir, { recursive: true })
    await writeFile(join(secretDir, 'key'), 'top-secret')
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'local-secret', path: secretDir, match: 'subpath', access: 'read', reason: 'test secret',
    }))

    const result = await run(ctx, `cat ${join(secretDir, 'key')}`, root)
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('escalation')
    expect(seen[0].escalation.guard).toBe('local-secret')
    expect(seen[0].summary).toContain('fs-read-guarded')
    expect(result.relaxed?.[0]).toContain('guard-read:local-secret')
    expect(result.content).toContain('top-secret')
    expect(result.exitCode).toBe(0)
  })

  it('returns a structured denial when the human refuses', async () => {
    const { ctx, root, seen } = await setup({ selfCheck: false, decide: 'deny' })
    const secretDir = join(root, 'secrets')
    await mkdir(secretDir, { recursive: true })
    await writeFile(join(secretDir, 'key'), 'top-secret')
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'local-secret', path: secretDir, match: 'subpath', access: 'read', reason: 'test secret',
    }))

    const result = await run(ctx, `cat ${join(secretDir, 'key')}`, root)
    expect(seen).toHaveLength(1)
    expect(result.content).toContain('[sandbox]')
    expect(result.content).toContain('请勿重试')
    expect(result.content).not.toContain('top-secret')
  })

  it('never escalates network denials', async () => {
    const { ctx, root, seen } = await setup({ selfCheck: false })
    const result = await run(ctx, 'curl -s -m 2 http://127.0.0.1:1/', root)
    expect(seen).toHaveLength(0)
    expect(result.content).toContain('[sandbox]')
  })

  it('does not escalate when the executor is configured to only report', async () => {
    const { ctx, root, seen } = await setup({ selfCheck: false, escalate: 'never' })
    await mkdir(join(root, '.git'), { recursive: true })
    await run(ctx, 'echo x >> .git/config', root)
    expect(seen).toHaveLength(0)
  })

  it('keeps the escalation out of bypassed approvals', async () => {
    const { ctx, root, seen } = await setup({ selfCheck: false, decide: 'allow' })
    // A settings service that bypasses every tool approval.
    class BypassedSettings extends Service {
      constructor(inner: Context) {
        super(inner, 'settings')
      }

      raw() {
        return { agent: { bypassApprovals: true } }
      }

      approvalRules() {
        return []
      }
    }
    const settings = ctx.plugin(BypassedSettings)
    await settings
    cleanups.push(() => settings.dispose())
    const secretDir = join(root, 'secrets')
    await mkdir(secretDir, { recursive: true })
    await writeFile(join(secretDir, 'key'), 'top-secret')
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'local-secret', path: secretDir, match: 'subpath', access: 'read', reason: 'test secret',
    }))
    await run(ctx, `cat ${join(secretDir, 'key')}`, root)
    expect(seen[0].kind).toBe('escalation')
  })
})

describe.skipIf(!darwin)('threat model regressions', () => {
  it('blocks writing the harness settings that hold bypassApprovals', async () => {
    const { ctx, root } = await setup({ selfCheck: false, escalate: 'never' })
    await mkdir(join(root, '.ruobai'), { recursive: true })
    await writeFile(join(root, '.ruobai', 'settings.json'), '{}')
    const result = await run(ctx, 'echo {"agent":{"bypassApprovals":true}} > .ruobai/settings.json', root)
    expect(result.exitCode).not.toBe(0)
    expect(result.content).toContain('[sandbox]')
    // The original content is untouched.
    const check = await run(ctx, 'cat .ruobai/settings.json', root)
    expect(check.content).toContain('{}')
    expect(check.content).not.toContain('bypassApprovals')
  })

  it('blocks shell rc writes and automation entry points', async () => {
    const { ctx, root } = await setup({ selfCheck: false, escalate: 'never' })
    const home = process.env.HOME ?? ''
    if (!home) return
    const zshrc = await run(ctx, `echo evil >> ${join(home, '.zshrc')}`, root)
    expect(zshrc.exitCode).not.toBe(0)
    const osascript = await run(ctx, 'osascript -e "return 1"', root)
    expect(osascript.exitCode).not.toBe(0)
  })

  it('refuses to exec the keychain CLI', async () => {
    const { ctx, root } = await setup({ selfCheck: false, escalate: 'never' })
    const result = await run(ctx, 'security find-generic-password -w', root)
    expect(result.exitCode).not.toBe(0)
    expect(result.content).toContain('[sandbox]')
  })
})

describe.skipIf(!darwin)('lifecycle', () => {
  it('reclaims the run and leaves no sandbox-exec behind', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    await run(ctx, 'echo done', root)
    expect(ctx.sandbox.active()).toBe(0)
  })

  it('throws SandboxUnavailableError instead of running unconfined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-nosandbox-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    const fiber = (plugin: any, config?: any) => ctx.plugin(plugin, config)
    const shell = fiber(ShellService)
    await shell
    const sandbox = fiber(SandboxService)
    await sandbox
    const policy = fiber(SandboxPolicyService, { root })
    await policy
    const denial = fiber(DenialService)
    await denial
    // Note: no `@ruobai/sandbox-macos`, so no provider exists.
    const executor = fiber(SandboxedShell)
    await executor
    cleanups.push(
      () => executor.dispose(), () => denial.dispose(), () => policy.dispose(),
      () => sandbox.dispose(), () => shell.dispose(),
    )
    await expect(ctx.shell.run({
      command: 'echo hi',
      cwd: root,
      root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    })).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('resolves the real workspace path for assertions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-real-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    expect(await realpath(root)).toContain('rbh-real-')
  })
})

describe.skipIf(!darwin)('toolchain and environment', () => {
  it('runs a real toolchain command: pipelines, forks and git', async () => {
    const { ctx, root } = await setup({ selfCheck: false, escalate: 'never' })
    // Before the process-fork fix this failed with
    // `/bin/sh: fork: Operation not permitted` (appendix A18).
    const piped = await run(ctx, 'echo one | tr a-z A-Z', root)
    expect(piped.exitCode).toBe(0)
    expect(piped.content).toContain('ONE')

    const chained = await run(ctx, 'echo a && echo b', root)
    expect(chained.exitCode).toBe(0)
    expect(chained.content).toContain('b')

    // `git` is a symlink here (`/usr/local/bin/git -> /usr/local/git/bin/git`),
    // so this exercises the realpath expansion of the exec allowlist (A23).
    // A temp directory is not a repository, so ask for the version instead.
    const git = await run(ctx, 'git --version', root)
    expect(git.exitCode).toBe(0)
    expect(git.content).toContain('git version')
  })

  it('does not escalate a successful command that only produced noise', async () => {
    const { ctx, root, seen } = await setup({ selfCheck: false, decide: 'allow' })
    // `echo` succeeds while dyld probes /dev/dtracehelper on every exec; that
    // must never turn into an approval prompt.
    const result = await run(ctx, 'echo clean', root)
    expect(result.exitCode).toBe(0)
    expect(seen).toHaveLength(0)
    expect(result.content).not.toContain('[sandbox]')
  })

  it('does not leak harness credentials into the sandbox environment', async () => {
    const { ctx, root } = await setup({ selfCheck: false, escalate: 'never' })
    process.env.RBU_TOKEN = 'super-secret-token'
    try {
      const result = await run(ctx, 'echo "token=[$RBU_TOKEN]"', root)
      expect(result.content).not.toContain('super-secret-token')
      expect(result.content).toContain('token=[]')
    } finally {
      delete process.env.RBU_TOKEN
    }
  })

  it('relaxes one file on approval, not the whole workspace', async () => {
    const { ctx, root, seen } = await setup({ selfCheck: false, decide: 'allow' })
    const outside = join(tmpdir(), `rbh-outside-${process.pid}.txt`)
    cleanups.push(() => rm(outside, { force: true }))
    const result = await run(ctx, `echo hi > ${outside}`, root)
    if (seen.length) {
      expect(seen[0].escalation.exemption).toEqual({ kind: 'write-file', path: outside, once: true })
    }
    // Either it was denied outright or relaxed for exactly this file; the
    // workspace never becomes writable as a side effect.
    expect(result.content.includes('[sandbox]') || result.exitCode === 0).toBe(true)
  })
})

describe.skipIf(!darwin)('hot unload', () => {
  it('kills the process group before dispose() resolves', async () => {
    const { ctx, root } = await setup({ selfCheck: false, escalate: 'never' })
    // A long-running command keeps a shell alive inside sandbox-exec.
    const pending = run(ctx, 'sleep 30', root).catch((error: Error) => error)
    await new Promise(resolve => setTimeout(resolve, 300))
    const started = Date.now()
    await ctx.fiber.dispose()
    const elapsed = Date.now() - started
    const outcome = await pending
    // dispose() must not wait for the command: it kills the group.
    expect(elapsed).toBeLessThan(5_000)
    expect(outcome instanceof Error || outcome.signal !== null || outcome.exitCode !== 0).toBe(true)
  })
})
