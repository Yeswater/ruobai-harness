import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@ruobai/cordis'
import { PathGuardError } from '@ruobai/sandbox'
import SandboxPolicyService, { canonicalPath, globToRegExp, guardMatches } from '../src/index.ts'

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
  it('guards .git writes, .env reads and harness state', async () => {
    const { defaultGuards } = await import('@ruobai/sandbox-guards')
    const guards = defaultGuards('/w', '/home/u')
    const ids = guards.map(guard => guard.id)
    expect(ids).toEqual(expect.arrayContaining(['git-dir', 'env-file', 'harness-state', 'ssh-keys', 'shell-rc']))
    expect(guards.find(guard => guard.id === 'ssh-keys')?.access).toBe('read')
    expect(guards.find(guard => guard.id === 'git-dir')?.path).toBe('/w/.git')
    await writeFile(join(tmpdir(), 'rbu-guard-probe'), '')
    await rm(join(tmpdir(), 'rbu-guard-probe'), { force: true })
  })
})
