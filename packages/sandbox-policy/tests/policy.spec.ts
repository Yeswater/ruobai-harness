import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@ruobai/cordis'
import { PathGuardError } from '@ruobai/sandbox'
import SandboxPolicyService, {
  canonicalPath,
  globToRegExp,
  guardMatches,
  resolveGitPaths,
} from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup(config: ConstructorParameters<typeof SandboxPolicyService>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rbh-policy-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = ctx.plugin(SandboxPolicyService, { root, ...config })
  await fiber
  cleanups.push(() => fiber.dispose())
  return { ctx, root, policy: ctx.sandboxPolicy }
}

describe('user settings drive the policy', () => {
  it('uses the domain list through the proxy and adds extra write roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-policy-settings-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    class StubSettings extends Service {
      constructor(inner: Context) {
        super(inner, 'settings')
      }

      get() {
        return {
          sandbox: {
            network: { allowedDomains: ['example.com'], allowLocalBinding: false },
            filesystem: { allowWrite: ['~/rbh-extra-write'] },
          },
        }
      }
    }
    const settings = ctx.plugin(StubSettings)
    await settings
    const fiber = ctx.plugin(SandboxPolicyService, { root })
    await fiber
    cleanups.push(() => fiber.dispose(), () => settings.dispose())

    const proxy = ctx.sandboxPolicy.forSession({ proxyPort: 7777 })
    expect(proxy.net).toMatchObject({ mode: 'proxy', allowLocalBinding: false })
    expect(proxy.fs.write.some(grant => grant.path.endsWith('/rbh-extra-write'))).toBe(true)

    // Without a proxy port the same list fails closed instead of opening a
    // kernel-level allowlist Seatbelt cannot express.
    expect(ctx.sandboxPolicy.forSession({}).net.mode).toBe('deny')
  })

  it('keeps localhost binding when the user allows it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-policy-local-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    class StubSettings extends Service {
      constructor(inner: Context) {
        super(inner, 'settings')
      }

      get() {
        return { sandbox: { network: { allowedDomains: [], allowLocalBinding: true } } }
      }
    }
    const settings = ctx.plugin(StubSettings)
    await settings
    const fiber = ctx.plugin(SandboxPolicyService, { root })
    await fiber
    cleanups.push(() => fiber.dispose(), () => settings.dispose())

    const snapshot = ctx.sandboxPolicy.forSession({})
    expect(snapshot.net).toMatchObject({ mode: 'deny', allowLocalBinding: true })
  })
  it('uses the built-in defaults before the user touches sandbox settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-policy-defaults-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    class EmptySettings extends Service {
      constructor(inner: Context) {
        super(inner, 'settings')
      }

      get() {
        return {}
      }
    }
    const settings = ctx.plugin(EmptySettings)
    await settings
    const fiber = ctx.plugin(SandboxPolicyService, { root })
    await fiber
    cleanups.push(() => fiber.dispose(), () => settings.dispose())

    expect(ctx.sandboxPolicy.forSession({ proxyPort: 7777 }).net).toMatchObject({
      mode: 'proxy',
      allowLocalBinding: true,
    })
  })
})

describe('globToRegExp', () => {
  it('keeps * inside a segment and lets ** cross directories', () => {
    expect(globToRegExp('/w/*.env').test('/w/a.env')).toBe(true)
    expect(globToRegExp('/w/*.env').test('/w/a/b.env')).toBe(false)
    expect(globToRegExp('/w/**/*.env').test('/w/a/b.env')).toBe(true)
  })
})

describe('guard matching', () => {
  it('matches subpaths and excludes siblings', () => {
    const guard = { id: 'g', path: '/w/.git', match: 'subpath' as const, access: 'write' as const, reason: '' }
    expect(guardMatches(guard, '/w/.git/config')).toBe(true)
    expect(guardMatches(guard, '/w/.gitee')).toBe(false)
    expect(guardMatches(guard, '/w/.git')).toBe(true)
  })

  it('folds case and NFC so .Git and NFD variants cannot slip through', () => {
    const guard = { id: 'g', path: '/w/.git', match: 'subpath' as const, access: 'write' as const, reason: '' }
    if (process.platform === 'darwin') {
      expect(guardMatches(guard, '/w/.Git/config')).toBe(true)
    }
    const nfd = '/w/.git'.normalize('NFD')
    expect(canonicalPath(nfd)).toBe(canonicalPath('/w/.git'))
    expect(guardMatches(guard, `${nfd}/config`)).toBe(true)
  })
})

describe('policy service', () => {
  it('throws a PathGuardError for a guarded write', async () => {
    const { policy, root } = await setup()
    const dispose = policy.registerGuard({
      id: 'git-dir',
      path: join(root, '.git'),
      match: 'subpath',
      access: 'write',
      reason: 'hooks',
    })
    cleanups.push(dispose)
    expect(() => policy.check(join(root, '.git', 'config'), 'write')).toThrow(PathGuardError)
    expect(() => policy.check(join(root, 'notes.txt'), 'write')).not.toThrow()
    expect(policy.guardFor(join(root, '.git', 'config'), 'write')).toBe('git-dir')
  })

  it('follows a symlink before deciding (no grant borrowing)', async () => {
    const { policy, root } = await setup()
    const secret = join(root, 'secret')
    await mkdir(secret, { recursive: true })
    const dispose = policy.registerGuard({
      id: 'secret', path: secret, match: 'subpath', access: 'read', reason: 'secret',
    })
    cleanups.push(dispose)
    const link = join(root, 'link')
    await symlink(secret, link)
    if (process.platform === 'darwin') {
      expect(() => policy.check(join(link, 'file'), 'read')).toThrow(PathGuardError)
    }
  })

  it('bumps the version when a guard is added or removed', async () => {
    const { policy, root } = await setup()
    const before = policy.currentVersion()
    const dispose = policy.registerGuard({
      id: 'env', path: join(root, '.env'), match: 'exact', access: 'read', reason: 'secrets',
    })
    expect(policy.currentVersion()).toBeGreaterThan(before)
    const bumped = policy.currentVersion()
    dispose()
    expect(policy.currentVersion()).toBeGreaterThan(bumped)
    expect(policy.listGuards()).toHaveLength(0)
  })

  it('builds a session snapshot with workspace and temp write grants', async () => {
    const { policy, root } = await setup({ network: { mode: 'deny' } })
    const snapshot = policy.forSession({ sessionId: 's1' })
    expect(snapshot.fs.write.some(grant => grant.path === root)).toBe(true)
    expect(snapshot.fs.read.some(grant => grant.path === root)).toBe(true)
    expect(snapshot.net.mode).toBe('deny')
    expect(snapshot.id).toBe('session:s1')
  })

  it('drops write grants in read-only mode', async () => {
    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'rbh-policy-ro-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    class ReadOnlyPermissions extends Service {
      constructor(inner: Context) {
        super(inner, 'permissions')
      }

      modeFor() {
        return 'read-only'
      }
    }
    const permissions = ctx.plugin(ReadOnlyPermissions)
    await permissions
    cleanups.push(() => permissions.dispose())
    const fiber = ctx.plugin(SandboxPolicyService, { root })
    await fiber
    cleanups.push(() => fiber.dispose())
    const snapshot = ctx.sandboxPolicy.forSession({ sessionId: 's1' })
    expect(snapshot.fs.write).toHaveLength(0)
  })

  it('does not grant home writes for full-access by default', async () => {
    const { policy } = await setup()
    const snapshot = policy.forSession()
    const home = process.env.HOME ?? ''
    if (home) {
      expect(snapshot.fs.write.some(grant => grant.path === home)).toBe(false)
    }
  })

  it('keeps a guard out of the snapshot after its disposer ran', async () => {
    const { policy, root } = await setup()
    const dispose = policy.registerGuard({
      id: 'tmp-guard', path: join(root, 'x'), match: 'subpath', access: 'write', reason: 'x',
    })
    expect(policy.forSession().fs.guardWrite).toHaveLength(1)
    dispose()
    expect(policy.forSession().fs.guardWrite).toHaveLength(0)
  })
})

describe('sandbox-guards defaults', () => {
  it('guards git persistence points, .env reads and harness state', async () => {
    const { defaultGuards } = await import('@ruobai/sandbox-guards')
    const guards = defaultGuards('/w', '/home/u')
    const ids = guards.map(guard => guard.id)
    expect(ids).toEqual(expect.arrayContaining([
      'git-hooks', 'git-config', 'git-alternates', 'env-file', 'harness-state', 'ssh-keys', 'shell-rc',
    ]))
    expect(ids).not.toContain('git-dir')
    expect(guards.find(guard => guard.id === 'ssh-keys')?.access).toBe('read')
    expect(guards.find(guard => guard.id === 'git-hooks')?.path).toBe('/w/.git/hooks')
    await writeFile(join(tmpdir(), 'rbu-guard-probe'), '')
    await rm(join(tmpdir(), 'rbu-guard-probe'), { force: true })
  })

  it('keeps normal git data writable while guarding persistence points', async () => {
    const { defaultGuards } = await import('@ruobai/sandbox-guards')
    const { guardMatches } = await import('@ruobai/sandbox-policy')
    const writeGuards = defaultGuards('/w', '/home/u').filter(guard => guard.access === 'write')
    const guarded = (path: string) => writeGuards.some(guard => guardMatches(guard, path))

    expect(guarded('/w/.git/index')).toBe(false)
    expect(guarded('/w/.git/index.lock')).toBe(false)
    expect(guarded('/w/.git/objects/ab/cdef')).toBe(false)
    expect(guarded('/w/.git/refs/heads/main')).toBe(false)
    expect(guarded('/w/.git/COMMIT_EDITMSG')).toBe(false)

    expect(guarded('/w/.git/hooks/pre-commit')).toBe(true)
    expect(guarded('/w/.git/config')).toBe(true)
    expect(guarded('/w/.git/objects/info/alternates')).toBe(true)
    expect(guarded('/w/.git/info/attributes')).toBe(true)
  })
})

describe('linked worktrees', () => {
  it('resolves the common git dir, grants both dirs and guards the pointer', async () => {
    const base = await mkdtemp(join(tmpdir(), 'rbh-worktree-'))
    cleanups.push(() => rm(base, { recursive: true, force: true }))
    const main = join(base, 'main')
    const wt = join(base, 'wt')
    await mkdir(main, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: main })
    execFileSync('git', ['config', 'user.email', 'probe@example.com'], { cwd: main })
    execFileSync('git', ['config', 'user.name', 'probe'], { cwd: main })
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: main })
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'probe'], { cwd: main })

    const mainReal = await realpath(main)
    const paths = resolveGitPaths(wt)
    expect(paths?.commonDir).toBe(join(mainReal, '.git'))
    expect(paths?.gitDir.startsWith(join(mainReal, '.git', 'worktrees'))).toBe(true)

    const ctx = new Context()
    const fiber = ctx.plugin(SandboxPolicyService, { root: wt })
    await fiber
    cleanups.push(() => fiber.dispose())
    const write = ctx.sandboxPolicy.forSession().fs.write.map(grant => grant.path)
    expect(write).toContain(join(mainReal, '.git'))
    expect(write.some(path => path.startsWith(join(mainReal, '.git', 'worktrees')))).toBe(true)

    const { defaultGuards } = await import('@ruobai/sandbox-guards')
    const guards = defaultGuards(wt, '/home/u')
    expect(guards.find(guard => guard.id === 'git-hooks')?.path)
      .toBe(join(mainReal, '.git', 'hooks'))
    expect(guards.find(guard => guard.id === 'git-worktree-pointer')?.path)
      .toBe(join(wt, '.git'))

    const writeGuards = guards.filter(guard => guard.access === 'write')
    const guarded = (path: string) => writeGuards.some(guard => guardMatches(guard, path))
    expect(guarded(join(mainReal, '.git', 'worktrees', 'probe', 'index'))).toBe(false)
    expect(guarded(join(mainReal, '.git', 'hooks', 'pre-commit'))).toBe(true)
  })
})
