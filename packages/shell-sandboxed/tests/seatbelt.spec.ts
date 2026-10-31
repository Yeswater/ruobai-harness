import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import { SandboxUnavailableError } from '@ruobai/sandbox'
import DenialService from '@ruobai/sandbox-denial'
import SandboxPolicyService from '@ruobai/sandbox-policy'
import SandboxService from '@ruobai/sandbox'
import DirectShell from '@ruobai/shell-direct'
import ShellService from '@ruobai/shell'
import SandboxedShell from '@ruobai/shell-sandboxed'
import SandboxGuards from '@ruobai/sandbox-guards'
import SandboxMacOs from '@ruobai/sandbox-macos'

const darwin = process.platform === 'darwin'
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/**
 * Whether this process can spawn `sandbox-exec` at all.
 *
 * Seatbelt cannot be nested: applying a profile from inside an existing one
 * fails with `sandbox_apply: Operation not permitted`. This suite therefore
 * cannot run inside the harness' own sandbox, which is exactly why the
 * provider's self-check reports `NestedSandboxError` instead of pretending.
 */
async function canNestSandboxExec(): Promise<boolean> {
  const { spawnSync } = await import('node:child_process')
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
    stdio: 'pipe',
    timeout: 5_000,
  })
  return probe.status === 0
}

const nested = await canNestSandboxExec()
// "skipNested" is only informational: describe.skipIf already carries it.

interface SetupOptions {
  selfCheck?: boolean
  network?: 'deny' | 'allowlist'
  /** Mount the direct executor for retries outside the sandbox. */
  withDirect?: boolean
  /** Reuse an existing directory (e.g. a linked worktree) instead of a temp one. */
  root?: string
}

async function setup(options: SetupOptions = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'rbh-sandbox-'))
  if (!options.root) cleanups.push(() => rm(root, { recursive: true, force: true }))
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
  const direct = options.withDirect ? ctx.plugin(DirectShell, { default: false }) : undefined
  await direct
  const sandboxedShell = ctx.plugin(SandboxedShell, {})
  await sandboxedShell

  cleanups.push(
    () => sandboxedShell.dispose(),
    () => direct?.dispose() ?? Promise.resolve(),
    () => macos.dispose(),
    () => denial.dispose(),
    () => guards.dispose(),
    () => policy.dispose(),
    () => sandbox.dispose(),
    () => shell.dispose(),
  )
  return { ctx, root, macos }
}

function run(ctx: Context, command: string, cwd: string, sessionId = 's1', sandbox?: boolean) {
  return ctx.shell.run({
    command,
    cwd,
    root: cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    sessionId,
    ...(sandbox === false ? { sandbox: false } : {}),
  })
}

describe.skipIf(!darwin || !nested)('seatbelt provider', () => {
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
    const { ctx, root } = await setup({ selfCheck: false })
    await mkdir(join(root, '.git'), { recursive: true })
    const result = await run(ctx, 'echo hacked >> .git/config', root)
    expect(result.exitCode).not.toBe(0)
    expect(result.denials.length).toBeGreaterThan(0)
    expect(result.content).toContain('[sandbox]')
  })

  it('lets ordinary git add/commit run while keeping hooks and config read-only', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    // The repo is created outside the sandbox: `git init` writes sample hooks,
    // which the agent-facing boundary deliberately denies.
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'probe@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'probe'], { cwd: root })
    await writeFile(join(root, 'file.txt'), 'hello\n')

    const identity = 'GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@example.com '
      + 'GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@example.com'

    const add = await run(ctx, `${identity} git add file.txt`, root)
    expect(add.exitCode).toBe(0)

    const commit = await run(ctx, `${identity} git commit -m probe`, root)
    expect(commit.exitCode).toBe(0)
    expect(commit.content).toContain('probe')

    const hooks = await run(ctx, 'echo x > .git/hooks/pre-commit', root)
    expect(hooks.exitCode).not.toBe(0)
    expect(hooks.denials.length).toBeGreaterThan(0)

    const config = await run(ctx, 'git config user.name other', root)
    expect(config.exitCode).not.toBe(0)
  })

  it('lets git add/commit run in a linked worktree', async () => {
    const base = await mkdtemp(join(tmpdir(), 'rbh-sandbox-wt-'))
    cleanups.push(() => rm(base, { recursive: true, force: true }))
    const main = join(base, 'main')
    const wt = join(base, 'wt')
    await mkdir(main, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: main })
    execFileSync('git', ['config', 'user.email', 'probe@example.com'], { cwd: main })
    execFileSync('git', ['config', 'user.name', 'probe'], { cwd: main })
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: main })
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'probe'], { cwd: main })
    await writeFile(join(wt, 'file.txt'), 'hello\n')

    const { ctx } = await setup({ root: wt, selfCheck: false })
    const identity = 'GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@example.com '
      + 'GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@example.com'

    const add = await run(ctx, `${identity} git add file.txt`, wt)
    expect(add.exitCode).toBe(0)
    const commit = await run(ctx, `${identity} git commit -m probe`, wt)
    expect(commit.exitCode).toBe(0)
  })

  it('denies reading a guarded file', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
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

describe.skipIf(!darwin || !nested)('sandbox boundary and the escape hatch', () => {
  it('explains a denial and allows one explicit unsandboxed retry', async () => {
    const { ctx, root } = await setup({ selfCheck: false, withDirect: true })
    const secretDir = join(root, 'secrets')
    await mkdir(secretDir, { recursive: true })
    await writeFile(join(secretDir, 'key'), 'top-secret')
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'local-secret', path: secretDir, match: 'subpath', access: 'read', reason: 'test secret',
    }))

    const denied = await run(ctx, `cat ${join(secretDir, 'key')}`, root)
    expect(denied.content).toContain('[sandbox]')
    expect(denied.content).toContain('dangerouslyDisableSandbox')
    expect(denied.content).not.toContain('top-secret')

    const retried = await run(ctx, `cat ${join(secretDir, 'key')}`, root, 's1', false)
    expect(retried.exitCode).toBe(0)
    expect(retried.sandboxed).toBe(false)
    expect(retried.executor).toBe('direct')
    expect(retried.content).toContain('未经沙箱执行')
    expect(retried.content).toContain('top-secret')
  })

  it('points network denials at the domain allowlist', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    const result = await run(ctx, 'curl -s -m 2 http://127.0.0.1:1/', root)
    expect(result.content).toContain('[sandbox]')
    expect(result.content).toContain('允许的域名')
  })

  it('fails closed when an unsandboxed retry is requested without a direct executor', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    await expect(run(ctx, 'echo hi', root, 's1', false)).rejects.toMatchObject({
      name: 'ShellUnavailableError',
    })
  })
})

describe.skipIf(!darwin || !nested)('threat model regressions', () => {
  it('blocks writing the harness settings that hold bypassApprovals', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
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
    const { ctx, root } = await setup({ selfCheck: false })
    const home = process.env.HOME ?? ''
    if (!home) return
    const zshrc = await run(ctx, `echo evil >> ${join(home, '.zshrc')}`, root)
    expect(zshrc.exitCode).not.toBe(0)
    const osascript = await run(ctx, 'osascript -e "return 1"', root)
    expect(osascript.exitCode).not.toBe(0)
  })

  it('refuses to exec the keychain CLI', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    const result = await run(ctx, 'security find-generic-password -w', root)
    expect(result.exitCode).not.toBe(0)
    expect(result.content).toContain('[sandbox]')
  })
})

describe.skipIf(!darwin || !nested)('lifecycle', () => {
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

describe.skipIf(!darwin || !nested)('toolchain and environment', () => {
  it('runs a real toolchain command: pipelines, forks and git', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
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

  it('does not attach a sandbox block to a successful quiet command', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    // `echo` succeeds while dyld probes /dev/dtracehelper on every exec; that
    // must never show up as a denial block.
    const result = await run(ctx, 'echo clean', root)
    expect(result.exitCode).toBe(0)
    expect(result.denials).toHaveLength(0)
    expect(result.content).not.toContain('[sandbox]')
  })

  it('does not leak harness credentials into the sandbox environment', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    process.env.RBU_TOKEN = 'super-secret-token'
    try {
      const result = await run(ctx, 'echo "token=[$RBU_TOKEN]"', root)
      expect(result.content).not.toContain('super-secret-token')
      expect(result.content).toContain('token=[]')
    } finally {
      delete process.env.RBU_TOKEN
    }
  })

  it('keeps an outside write denied without widening the workspace', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
    // The temp directory is a granted write root; home is read-only.
    const outside = join(homedir(), `.rbh-outside-${process.pid}-${Date.now()}.txt`)
    cleanups.push(() => rm(outside, { force: true }))
    const result = await run(ctx, `echo hi > ${outside}`, root)
    expect(result.exitCode).not.toBe(0)
    expect(result.content).toContain('[sandbox]')
    expect(await readFile(outside, 'utf8').catch(() => null)).toBeNull()
    // The workspace itself stays writable; only the denial is confined.
    const inside = await run(ctx, 'echo hi > ok.txt', root)
    expect(inside.exitCode).toBe(0)
  })
})

describe.skipIf(!darwin || !nested)('hot unload', () => {
  it('kills the process group before dispose() resolves', async () => {
    const { ctx, root } = await setup({ selfCheck: false })
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
