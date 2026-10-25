import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import {
  SandboxUnavailableError,
  type SandboxHandle,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxRunResult,
  type SandboxSpec,
} from './types.ts'

export * from './types.ts'

interface TrackedRun {
  handle: SandboxHandle
  provider: SandboxProvider
  abort: AbortController
  owner: number | null
}

declare module '@ruobai/cordis' {
  interface Context {
    sandbox: SandboxService
  }

  interface Events {
    'sandbox/run-start'(spec: SandboxSpec): void
    'sandbox/run-end'(spec: SandboxSpec, result: SandboxRunResult): void
    'sandbox/provider-changed'(providerId: string | undefined, platform: string): void
  }
}

/**
 * Provider registry, run bookkeeping and the lifecycle backstop.
 *
 * Ownership is split three ways on purpose: the provider owns the real OS
 * resources, this service owns the registry so a leaked handle can be found
 * from anywhere, and the calling fiber owns the scope. `run()` returns no
 * handle, so callers cannot leak one.
 */
export class SandboxService extends Service {
  private readonly providers = new Map<string, SandboxProvider>()
  private readonly runs = new Map<string, TrackedRun>()
  private draining = false

  constructor(ctx: Context) {
    super(ctx, 'sandbox')
    ctx.effect(() => () => {
      // Backstop: drop the capability first, then abort and reclaim.
      this.draining = true
      const all = [...this.runs.values()]
      for (const run of all) run.abort.abort()
      const providers = [...new Set(all.map(run => run.provider))]
      const tracked = [...this.providers.values()].filter(provider => !providers.includes(provider))
      return Promise.all([
        ...tracked.map(provider => provider.destroyAll().catch(() => undefined)),
        ...providers.map(provider => provider.destroyAll().catch(() => undefined)),
      ]).then(() => {
        this.runs.clear()
        this.providers.clear()
      })
    }, 'sandbox.dispose')
  }

  /**
   * Register a platform backend. The disposer removes it from the table
   * *first* (so a new `execute` fails closed instead of hitting a dead
   * provider) and only then reclaims its resources.
   */
  registerProvider(provider: SandboxProvider): () => void {
    const previous = this.providers.get(provider.platform)
    this.providers.set(provider.platform, provider)
    this.ctx.emit('sandbox/provider-changed', provider.id, provider.platform)
    return () => {
      if (previous) this.providers.set(provider.platform, previous)
      else this.providers.delete(provider.platform)
      this.ctx.emit('sandbox/provider-changed', previous?.id, provider.platform)
      void provider.destroyAll().catch((error) => {
        this.ctx.logger('sandbox').warn(error)
      })
    }
  }

  provider(platform: NodeJS.Platform = process.platform as NodeJS.Platform): SandboxProvider | undefined {
    if (this.draining) return undefined
    const provider = this.providers.get(platform)
    if (!provider?.available) return undefined
    return provider
  }

  /** Number of in-flight runs; used by tests and by the lifecycle backstop. */
  active(): number {
    return this.runs.size
  }

  async compile(policy: SandboxPolicy, relax?: Parameters<SandboxProvider['compile']>[1]) {
    const provider = this.provider()
    if (!provider) throw new SandboxUnavailableError()
    return provider.compile(policy, relax)
  }

  /**
   * Runs one confined command. Everything is tracked and reclaimed here, so
   * the caller gets a plain result and no handle.
   */
  async execute(spec: SandboxSpec): Promise<SandboxRunResult> {
    const provider = this.provider()
    if (!provider) throw new SandboxUnavailableError()

    const runId = spec.runId || randomUUID()
    const handle = this.track(provider, { ...spec, runId })
    this.ctx.emit('sandbox/run-start', spec)
    try {
      const prepared = await provider.compile(spec.policy, spec.relax)
      const result = await provider.execute({ ...spec, runId, signal: handle.abort.signal }, prepared)
      this.ctx.emit('sandbox/run-end', spec, result)
      return result
    } finally {
      // Disposal order matters: untrack first so a disabled sandbox cannot
      // report a live run, then let the provider kill the process group.
      this.runs.delete(runId)
      await provider.destroy(handle.handle).catch((error) => {
        this.ctx.logger('sandbox').warn(error)
      })
    }
  }

  /** In-process file IO through the provider, for tools that bypass the shell. */
  async readFile(path: string, options: { encoding?: BufferEncoding } = {}): Promise<Buffer | string> {
    const provider = this.provider()
    if (!provider) throw new SandboxUnavailableError()
    const handle = this.sessionHandle(provider)
    try {
      return await provider.readFile(path, options, handle)
    } finally {
      await provider.destroy(handle).catch(() => undefined)
    }
  }

  async writeFile(path: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
    const provider = this.provider()
    if (!provider) throw new SandboxUnavailableError()
    const handle = this.sessionHandle(provider)
    try {
      await provider.writeFile(path, data, options, handle)
    } finally {
      await provider.destroy(handle).catch(() => undefined)
    }
  }

  private track(provider: SandboxProvider, spec: SandboxSpec): TrackedRun {
    const handle: SandboxHandle = {
      id: spec.runId,
      providerId: provider.id,
      kind: 'run',
      createdAt: Date.now(),
    }
    const entry: TrackedRun = {
      handle,
      provider,
      abort: new AbortController(),
      owner: this.ctx.fiber?.uid ?? null,
    }
    this.runs.set(spec.runId, entry)
    return entry
  }

  private sessionHandle(provider: SandboxProvider): SandboxHandle {
    return {
      id: `io-${randomUUID()}`,
      providerId: provider.id,
      kind: 'session',
      createdAt: Date.now(),
    }
  }
}

export default SandboxService

export const meta = {
  title: '沙箱服务',
  description: '平台后端注册表、执行登记与生命周期兜底。',
}
