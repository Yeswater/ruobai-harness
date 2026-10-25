import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SandboxService, {
  SandboxUnavailableError,
  type Capability,
  type Exemption,
  type PreparedPolicy,
  type SandboxHandle,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxRunResult,
  type SandboxSpec,
} from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const policy: SandboxPolicy = {
  id: 'test',
  version: 1,
  fs: { read: [], write: [], guardRead: [], guardWrite: [] },
  net: { mode: 'deny', allow: [] },
  exec: { allowPaths: [] },
  limits: { timeoutMs: 1_000, maxOutputBytes: 1_024 },
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: 'r1',
    command: 'echo hi',
    cwd: '/tmp',
    policy,
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    ...overrides,
  }
}

class FakeProvider implements SandboxProvider {
  readonly platform = 'darwin' as NodeJS.Platform
  readonly id = 'fake'
  readonly capabilities = new Set<Capability>(['kernel-fs'])
  constructor(public available = true) {}
  compiled: Array<readonly Exemption[] | undefined> = []
  destroyed: string[] = []
  destroysAll = 0
  running?: (signal: AbortSignal) => void
  files = new Map<string, string>()

  compile(_policy: SandboxPolicy, relax?: readonly Exemption[]): Promise<PreparedPolicy> {
    this.compiled.push(relax)
    return Promise.resolve({ text: 'profile', digest: 'digest', warnings: [] })
  }

  execute(input: SandboxSpec, prepared: PreparedPolicy): Promise<SandboxRunResult> {
    void prepared
    return new Promise((resolve) => {
      this.running?.(input.signal!)
      input.signal?.addEventListener('abort', () => {
        resolve({
          runId: input.runId,
          exitCode: null,
          signal: 'SIGKILL',
          stdout: '',
          stderr: 'aborted',
          durationMs: 1,
          truncated: false,
          denials: [],
        })
      }, { once: true })
      if (!this.running) {
        resolve({
          runId: input.runId,
          exitCode: 0,
          signal: null,
          stdout: 'ok',
          stderr: '',
          durationMs: 1,
          truncated: false,
          denials: [],
        })
      }
    })
  }

  async readFile(path: string) {
    return this.files.get(path) ?? ''
  }

  async writeFile(path: string, data: string | Uint8Array) {
    this.files.set(path, String(data))
  }

  async destroy(handle: SandboxHandle) {
    this.destroyed.push(handle.id)
  }

  async destroyAll() {
    this.destroysAll++
  }
}

async function setup() {
  const ctx = new Context()
  const fiber = ctx.plugin(SandboxService)
  await fiber
  cleanups.push(() => fiber.dispose())
  return { ctx, fiber }
}

describe('SandboxService', () => {
  it('fails closed with no provider', async () => {
    const { ctx } = await setup()
    expect(ctx.sandbox.provider('darwin')).toBeUndefined()
    await expect(ctx.sandbox.execute(spec())).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('hides a provider that is not available', async () => {
    const { ctx } = await setup()
    const provider = new FakeProvider(false)
    cleanups.push(ctx.sandbox.registerProvider(provider))
    expect(ctx.sandbox.provider('darwin')).toBeUndefined()
    await expect(ctx.sandbox.execute(spec())).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('runs, tracks and reclaims the handle', async () => {
    const { ctx } = await setup()
    const provider = new FakeProvider()
    cleanups.push(ctx.sandbox.registerProvider(provider))
    const result = await ctx.sandbox.execute(spec())
    expect(result.stdout).toBe('ok')
    expect(ctx.sandbox.active()).toBe(0)
    expect(provider.destroyed).toEqual(['r1'])
  })

  it('reclaims the handle even when the provider throws', async () => {
    const { ctx } = await setup()
    const provider = new FakeProvider()
    provider.execute = () => Promise.reject(new Error('boom'))
    cleanups.push(ctx.sandbox.registerProvider(provider))
    await expect(ctx.sandbox.execute(spec())).rejects.toThrow('boom')
    expect(ctx.sandbox.active()).toBe(0)
    expect(provider.destroyed).toEqual(['r1'])
  })

  it('removes the provider before reclaiming it', async () => {
    const { ctx } = await setup()
    const provider = new FakeProvider()
    const dispose = ctx.sandbox.registerProvider(provider)
    dispose()
    expect(ctx.sandbox.provider('darwin')).toBeUndefined()
    // destroyAll is async; the capability must be gone synchronously.
    await Promise.resolve()
    expect(provider.destroysAll).toBe(1)
  })

  it('restores the previous provider on double mount', async () => {
    const { ctx } = await setup()
    const first = new FakeProvider()
    const second = new FakeProvider()
    const disposeFirst = ctx.sandbox.registerProvider(first)
    const disposeSecond = ctx.sandbox.registerProvider(second)
    expect(ctx.sandbox.provider('darwin')?.id).toBe('fake')
    disposeSecond()
    expect(ctx.sandbox.provider('darwin')).toBe(first)
    disposeFirst()
    expect(ctx.sandbox.provider('darwin')).toBeUndefined()
  })

  it('aborts in-flight runs and reclaims everything on unload', async () => {
    const { ctx, fiber } = await setup()
    const sandboxService = ctx.sandbox
    const provider = new FakeProvider()
    provider.running = () => undefined
    ctx.sandbox.registerProvider(provider)
    const pending = ctx.sandbox.execute(spec({ runId: 'hang' }))
    await Promise.resolve()
    expect(ctx.sandbox.active()).toBe(1)
    const disposal = fiber.dispose()
    const result = await pending
    await disposal
    expect(result.signal).toBe('SIGKILL')
    expect(provider.destroysAll).toBeGreaterThan(0)
    expect(sandboxService.active()).toBe(0)
  })

  it('routes in-process file IO through the provider', async () => {
    const { ctx } = await setup()
    const provider = new FakeProvider()
    cleanups.push(ctx.sandbox.registerProvider(provider))
    await ctx.sandbox.writeFile('/w/a.txt', 'hello')
    expect(await ctx.sandbox.readFile('/w/a.txt')).toBe('hello')
    expect(provider.destroyed).toHaveLength(2)
  })

  it('passes relax exemptions straight to compile', async () => {
    const { ctx } = await setup()
    const provider = new FakeProvider()
    cleanups.push(ctx.sandbox.registerProvider(provider))
    await ctx.sandbox.execute(spec({ relax: [{ kind: 'guard-read', guard: 'ssh-keys' }] }))
    expect(provider.compiled[0]).toEqual([{ kind: 'guard-read', guard: 'ssh-keys' }])
  })
})
