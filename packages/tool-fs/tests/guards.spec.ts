import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@ruobai/cordis'
import { PathGuardError } from '@ruobai/sandbox'
import SandboxPolicyService from '@ruobai/sandbox-policy'
import ToolRegistry from '@ruobai/tools'
import FsTools from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup(options: { withSandbox?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rbh-tool-fs-guard-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const tools = ctx.plugin(ToolRegistry)
  await tools
  cleanups.push(() => tools.dispose())

  let policy: { dispose(): Promise<void> } | undefined
  if (options.withSandbox !== false) {
    policy = ctx.plugin(SandboxPolicyService, { root })
    await policy
    cleanups.push(() => policy!.dispose())
  }
  const fs = ctx.plugin(FsTools, { root })
  await fs
  cleanups.push(() => fs.dispose())

  // Auto-approve so the guard is the only thing under test.
  class AutoApprove extends Service {
    constructor(inner: Context) {
      super(inner, 'approval')
    }

    async request() {
      return 'allow' as const
    }
  }
  const approval = ctx.plugin(AutoApprove)
  await approval
  cleanups.push(() => approval.dispose())

  return { ctx, root, policy }
}

describe('tool-fs sandbox guards', () => {
  it('refuses to write .git through write_file', async () => {
    const { ctx, root } = await setup()
    await mkdir(join(root, '.git'), { recursive: true })
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'git-dir', path: join(root, '.git'), match: 'subpath', access: 'write', reason: 'hooks',
    }))
    const result = await ctx.tools.invoke('write_file', { path: '.git/config', content: 'evil' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('git-dir')
  })

  it('refuses to read a guarded file through read_file', async () => {
    const { ctx, root } = await setup()
    const secret = join(root, 'secret.txt')
    await writeFile(secret, 'top-secret')
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'secret', path: secret, match: 'exact', access: 'read', reason: 'secrets',
    }))
    const result = await ctx.tools.invoke('read_file', { path: 'secret.txt' })
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('top-secret')
    expect(result.content).toContain('secret')
  })

  it('refuses to edit a guarded file', async () => {
    const { ctx, root } = await setup()
    await mkdir(join(root, '.ruobai'), { recursive: true })
    await writeFile(join(root, '.ruobai', 'settings.json'), '{}')
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'harness-state', path: join(root, '.ruobai'), match: 'subpath', access: 'write', reason: 'state',
    }))
    const result = await ctx.tools.invoke('edit_file', {
      path: '.ruobai/settings.json',
      oldText: '{}',
      newText: '{"agent":{"bypassApprovals":true}}',
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('harness-state')
  })

  it('still writes ordinary workspace files', async () => {
    const { ctx, root } = await setup()
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'git-dir', path: join(root, '.git'), match: 'subpath', access: 'write', reason: 'hooks',
    }))
    const result = await ctx.tools.invoke('write_file', { path: 'notes.txt', content: 'hello' })
    expect(result.isError).toBe(false)
    expect(await ctx.tools.invoke('read_file', { path: 'notes.txt' })).toMatchObject({ content: 'hello' })
  })

  it('drops the guard as soon as its disposer runs', async () => {
    const { ctx, root } = await setup()
    await mkdir(join(root, '.git'), { recursive: true })
    const dispose = ctx.sandboxPolicy.registerGuard({
      id: 'git-dir', path: join(root, '.git'), match: 'subpath', access: 'write', reason: 'hooks',
    })
    expect((await ctx.tools.invoke('write_file', { path: '.git/config', content: 'x' })).isError).toBe(true)
    dispose()
    const after = await ctx.tools.invoke('write_file', { path: '.git/config', content: 'x' })
    expect(after.isError).toBe(false)
  })

  it('behaves as before when no sandbox policy is mounted', async () => {
    const { ctx } = await setup({ withSandbox: false })
    const result = await ctx.tools.invoke('write_file', { path: 'plain.txt', content: 'ok' })
    expect(result.isError).toBe(false)
  })

  it('stops guarding when the policy service unloads (hot unload)', async () => {
    const { ctx, root, policy } = await setup()
    await mkdir(join(root, '.git'), { recursive: true })
    ctx.sandboxPolicy.registerGuard({
      id: 'git-dir', path: join(root, '.git'), match: 'subpath', access: 'write', reason: 'hooks',
    })
    expect((await ctx.tools.invoke('write_file', { path: '.git/config', content: 'x' })).isError).toBe(true)
    // Unloading the policy service must not leave a stale guard behind.
    await policy!.dispose()
    expect((await ctx.tools.invoke('write_file', { path: '.git/config', content: 'x' })).isError).toBe(false)
  })

  it('raises PathGuardError with the reason for the model', async () => {
    const { ctx, root } = await setup()
    await mkdir(join(root, '.git'), { recursive: true })
    cleanups.push(ctx.sandboxPolicy.registerGuard({
      id: 'git-dir', path: join(root, '.git'), match: 'subpath', access: 'write', reason: 'hooks 不得被写入',
    }))
    try {
      ctx.sandboxPolicy.check(join(root, '.git', 'config'), 'write')
      throw new Error('expected a PathGuardError')
    } catch (error) {
      expect(error).toBeInstanceOf(PathGuardError)
      expect((error as Error).message).toContain('hooks 不得被写入')
    }
  })
})
