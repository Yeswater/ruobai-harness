import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile as readFileNode, rm, writeFile as writeFileNode } from 'node:fs/promises'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type {
  Exemption,
  PreparedPolicy,
  RawDenialRecord,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  SandboxRunResult,
  SandboxSpec,
} from '@ruobai/sandbox'
import { NestedSandboxError, TOOLCHAIN_EXEC } from '@ruobai/sandbox'
import { compileProfile, DEFAULT_DENIED_EXECUTABLES, type CompileOptions } from './sbpl.ts'

export * from './sbpl.ts'

export interface Config {
  sandboxExec?: string
  /** Run the probe suite before exposing the provider. Fail-closed. */
  selfCheck?: boolean
  /** Extra executables allowed to run inside the profile. */
  execAllowPaths?: string[]
  /** Executables denied by name, e.g. `/usr/bin/security`. */
  deniedExecutables?: string[]
  machLookup?: 'allow' | 'deny'
  processInfo?: 'allow' | 'deny'
  /**
   * Whether commands may fork. Must stay `allow`: under `(deny default)` a
   * shell cannot fork, so pipelines, `&&` and any tool that spawns a helper
   * (git, npm, node) fail with `fork: Operation not permitted`.
   */
  processFork?: 'allow' | 'deny'
  /** Root probe directory; defaults to the policy root at execute time. */
  probeRoot?: string
}

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/**
 * Environment used when the caller does not supply one.
 *
 * Deliberately *not* `process.env`: inheriting the harness environment would
 * hand `RBU_TOKEN` and provider API keys to every sandboxed command, which
 * Seatbelt does not restrict at all. Callers that need more pass their own
 * scrubbed environment explicitly.
 */
export function minimalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
    HOME: source.HOME ?? '/',
    TMPDIR: source.TMPDIR ?? tmpdir(),
    LANG: source.LANG ?? 'en_US.UTF-8',
    SHELL: '/bin/sh',
  }
}

/**
 * Seatbelt matches on the resolved vnode path, so `/var` must become
 * `/private/var`. A guard target usually does not exist yet, so the deepest
 * existing ancestor is resolved and the rest is re-appended — otherwise
 * `<ws>/.ruobai` would be compiled as `/var/...` and never match
 * `/private/var/...`, silently disabling the guard.
 */
export function realpathOr(path: string): string {
  let current = path
  const rest: string[] = []
  for (;;) {
    try {
      const resolved = realpathSync(current)
      return rest.length ? join(resolved, ...rest) : resolved
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/** Resolves the concrete prefix of a glob pattern, keeping the glob part. */
export function realpathPattern(path: string): string {
  const index = path.search(/[*?]/)
  if (index < 0) return realpathOr(path)
  const prefix = path.slice(0, index)
  const cut = prefix.lastIndexOf('/')
  if (cut < 0) return path
  return realpathOr(prefix.slice(0, cut) || '/') + path.slice(cut)
}

/** Directories whose contents are shipped by the OS; they never link outside. */
const SYSTEM_EXEC_DIRS: ReadonlySet<string> = new Set([
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
])

/**
 * Expands a PATH-like directory list into the directories actually executed.
 *
 * Seatbelt judges `process-exec` by the **resolved vnode**, so a symlinked
 * entry is allowed or denied according to its *target*. `/usr/local/bin/git`
 * is a link to `/usr/local/git/bin/git`, so granting exec on
 * `/usr/local/bin` alone leaves `git` unrunnable (appendix A23). For every
 * entry that is a symlink, the target's directory is added.
 */
export function expandExecDirs(
  dirs: readonly string[],
  skip: ReadonlySet<string> = SYSTEM_EXEC_DIRS,
): string[] {
  const resolved = new Set<string>()
  for (const dir of dirs) {
    if (!dir) continue
    const real = realpathOr(dir)
    resolved.add(real)
    if (skip.has(real)) continue
    let entries: string[]
    try {
      entries = readdirSync(real)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(real, name)
      try {
        if (!lstatSync(full).isSymbolicLink()) continue
        resolved.add(dirname(realpathSync(full)))
      } catch {
        // Dangling or unreadable link: nothing to grant.
      }
    }
  }
  return [...resolved]
}

/**
 * Rewrites a policy's paths to their resolved form. A profile built from
 * `/var/folders/...` never matches the vnode under `/private/var/folders/...`,
 * which would silently disable both grants and guards.
 */
export function resolvePolicyPaths(policy: SandboxPolicy): SandboxPolicy {
  const grant = (value: { path: string; recursive: boolean }) => ({ ...value, path: realpathOr(value.path) })
  const guard = (value: SandboxPolicy['fs']['guardWrite'][number]) => ({
    ...value,
    path: value.match === 'glob' ? realpathPattern(value.path) : realpathOr(value.path),
  })
  return {
    ...policy,
    fs: {
      read: policy.fs.read.map(grant),
      write: policy.fs.write.map(grant),
      guardRead: policy.fs.guardRead.map(guard),
      guardWrite: policy.fs.guardWrite.map(guard),
    },
    exec: { allowPaths: policy.exec.allowPaths.map(realpathOr) },
  }
}

interface ChildEntry {
  child: ChildProcess
  pids: Set<number>
}

function killGroup(child: ChildProcess, graceMs = 500) {
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    }
  }
  signalGroup('SIGTERM')
  const hard = setTimeout(() => signalGroup('SIGKILL'), graceMs)
  if (typeof hard.unref === 'function') hard.unref()
  child.once('close', () => clearTimeout(hard))
}

interface RunOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
  failure?: Error
  pid?: number
}

/**
 * Seatbelt backend. Everything macOS-specific lives here: SBPL text, the
 * `sandbox-exec -f /dev/fd/3` invocation (never a temp file, never `-p`, so the
 * profile cannot be read by the sandboxed process nor leak through `ps`), and
 * the `execvp`/exit-71 signature documented in appendix A1.
 */
export class SeatbeltProvider implements SandboxProvider {
  readonly platform: NodeJS.Platform = 'darwin'
  readonly id = 'darwin-seatbelt'
  readonly capabilities = new Set([
    'kernel-fs',
    'kernel-net',
    'kernel-exec',
    'process-scoped',
  ] as const)

  private readonly children = new Map<string, ChildEntry>()
  private readonly cache = new Map<string, PreparedPolicy>()
  private ready: boolean
  private failure: string | undefined
  private lastDigest: string | undefined

  constructor(protected readonly config: Config = {}) {
    this.ready = config.selfCheck === false
  }

  get available(): boolean {
    return this.ready && !this.failure
  }

  get extensions(): Readonly<Record<string, unknown>> {
    return {
      sandboxExec: this.config.sandboxExec ?? SANDBOX_EXEC,
      profileDigest: this.lastDigest,
      ...(this.failure ? { failure: this.failure } : {}),
    }
  }

  async compile(policy: SandboxPolicy, relax: readonly Exemption[] = []): Promise<PreparedPolicy> {
    const key = `${policy.version}:${JSON.stringify(relax ?? [])}`
    const cached = this.cache.get(key)
    if (cached && cached.digest) return Promise.resolve(cached)
    const nodeBin = dirname(process.execPath)
    const options: CompileOptions = {
      // exec allowlist. Notes from real runs (appendix A20/A22/A23):
      // - a version manager puts node/npm/npx outside /usr/bin, and
      //   `#!/usr/bin/env node` cannot start without them;
      // - npm installs shims as symlinks into `lib/node_modules/<pkg>/bin`, and
      //   a shebang script needs exec rights on its own resolved vnode, so the
      //   node *root* (not just bin) has to be granted;
      // - `/usr/local/bin/git` links to `/usr/local/git/bin/git`, and
      //   `/usr/bin/git` re-execs xcrun, which dlopens libxcrun from the
      //   developer directory — hence the PATH symlink expansion and
      //   TOOLCHAIN_EXEC.
      execAllowPaths: [
        ...(this.config.execAllowPaths ?? []),
        nodeBin,
        dirname(nodeBin),
        ...TOOLCHAIN_EXEC.filter(path => existsSync(path)),
        ...expandExecDirs(this.pathDirs()),
      ].map(realpathOr),
      deniedExecutables: this.config.deniedExecutables ?? DEFAULT_DENIED_EXECUTABLES,
      machLookup: this.config.machLookup ?? 'allow',
      processInfo: this.config.processInfo ?? 'allow',
      processFork: this.config.processFork ?? 'allow',
    }
    // Exemption paths come from denial targets and are matched against vnodes
    // too, so they need the same realpath treatment as the policy.
    const resolvedRelax = relax.map((entry) => {
      if (entry.kind === 'write-file') return { ...entry, path: realpathOr(entry.path) }
      if (entry.kind === 'write-root') return { ...entry, path: realpathOr(entry.path) }
      return entry
    })
    const compiled = compileProfile(resolvePolicyPaths(policy), resolvedRelax, options)
    // Warnings are diagnostic only; they never relax the profile. They ride
    // along on the prepared policy so the caller can surface them.
    const warnings = [...compiled.warnings]
    const prepared: PreparedPolicy = { text: compiled.text, digest: compiled.digest, warnings }
    this.cache.set(key, prepared)
    this.lastDigest = prepared.digest
    return prepared
  }

  async execute(spec: SandboxSpec, prepared: PreparedPolicy): Promise<SandboxRunResult> {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const exec = this.config.sandboxExec ?? SANDBOX_EXEC
    const args = ['-f', '/dev/fd/3', shell, '-c', spec.command]

    const outcome = await this.run(exec, args, prepared.text, spec)
    if (outcome.exitCode === 71 && /sandbox_apply/.test(outcome.stderr)) {
      // Fail closed with a diagnosable error instead of a vague EPERM.
      throw new NestedSandboxError()
    }
    const denials: RawDenialRecord[] = []
    return {
      runId: spec.runId,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      durationMs: outcome.durationMs,
      truncated: outcome.truncated,
      denials,
      profileDigest: prepared.digest,
      ...(outcome.pid ? { pids: [outcome.pid] } : {}),
    }
  }

  async readFile(path: string, options: { encoding?: BufferEncoding }, _handle: SandboxHandle) {
    return options.encoding ? readFileNode(path, { encoding: options.encoding }) : readFileNode(path)
  }

  async writeFile(path: string, data: string | Uint8Array, options: { mode?: number }, _handle: SandboxHandle) {
    await mkdir(dirname(path), { recursive: true })
    await writeFileNode(path, data, options.mode === undefined ? undefined : { mode: options.mode })
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const entry = this.children.get(handle.id)
    if (!entry) return
    this.children.delete(handle.id)
    if (!entry.child.killed) killGroup(entry.child)
    await new Promise<void>((resolve) => {
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return resolve()
      const timer = setTimeout(resolve, 1_000)
      entry.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async destroyAll(): Promise<void> {
    const entries = [...this.children.entries()]
    this.children.clear()
    for (const [, entry] of entries) killGroup(entry.child)
    this.cache.clear()
    await Promise.all(entries.map(([, entry]) => new Promise<void>((resolve) => {
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return resolve()
      const timer = setTimeout(resolve, 1_000)
      entry.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })))
  }

  /**
   * Probe suite. A profile that fails to deny a guarded read/write is not a
   * weaker sandbox, it is a broken one, so the provider stays unavailable.
   */
  async selfCheck(root: string): Promise<void> {
    if (this.config.selfCheck === false) {
      this.ready = true
      return
    }
    const probeRoot = this.config.probeRoot ?? join(tmpdir(), `ruobai-sandbox-probe-${process.pid}`)
    const blockedDir = join(probeRoot, 'blocked')
    try {
      await access(this.config.sandboxExec ?? SANDBOX_EXEC, constants.X_OK)
      await mkdir(blockedDir, { recursive: true })
      const policy = probePolicy(probeRoot, blockedDir)
      const prepared = await this.compile(policy)
      const denied = await this.run(
        this.config.sandboxExec ?? SANDBOX_EXEC,
        ['-f', '/dev/fd/3', '/bin/sh', '-c', `echo probe > ${shellQuote(join(blockedDir, 'sandbox-probe'))}`],
        prepared.text,
        probeSpec(probeRoot),
      )
      const blocked = denied.exitCode !== 0
        || /Operation not permitted|not permitted/i.test(denied.stderr)
        || /deny/i.test(denied.stderr)
      await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined)
      if (denied.exitCode === 71 && /sandbox_apply/.test(denied.stderr)) {
        // Already inside a profile (e.g. launched by bin/rbu-jail): nesting is
        // impossible, so report it instead of pretending the sandbox works.
        this.failure = 'cannot nest sandbox-exec: the harness is already inside a Seatbelt profile'
      } else if (!blocked) {
        this.failure = 'self-check: a guarded write succeeded, refusing to expose the provider'
      } else {
        this.ready = true
      }
    } catch (error) {
      this.failure = `self-check failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** Reason the provider is unavailable, for logs and the UI. */
  get failureReason(): string | undefined {
    return this.failure
  }

  /**
   * Every directory a command might resolve from: the minimal PATH the
   * provider actually spawns with, plus the harness PATH that
   * `shell-sandboxed` forwards (which carries nvm/volta/etc.).
   */
  private pathDirs(): string[] {
    const dirs = new Set<string>()
    for (const source of [minimalEnv().PATH, process.env.PATH]) {
      for (const dir of (source ?? '').split(':')) {
        if (dir) dirs.add(dir)
      }
    }
    return [...dirs]
  }

  private run(exec: string, args: string[], profile: string, spec: {
    cwd: string
    timeoutMs: number
    maxOutputBytes: number
    signal?: AbortSignal
    runId: string
    env?: NodeJS.ProcessEnv
  }): Promise<RunOutcome> {
    return new Promise((resolve) => {
      const child = spawn(exec, args, {
        cwd: spec.cwd,
        env: spec.env ?? minimalEnv(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      })
      const entry: ChildEntry = { child, pids: new Set(child.pid ? [child.pid] : []) }
      this.children.set(spec.runId, entry)

      const started = Date.now()
      const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }
      let sizes = 0
      let truncated = false
      let settled = false
      let failure: Error | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let force: ReturnType<typeof setTimeout> | undefined

      const collect = (stream: 'stdout' | 'stderr', data: Buffer) => {
        const remaining = spec.maxOutputBytes - sizes
        if (remaining <= 0) {
          truncated = true
          return
        }
        const slice = data.length > remaining ? data.subarray(0, remaining) : data
        chunks[stream].push(slice)
        sizes += slice.length
        if (slice.length < data.length) truncated = true
      }

      const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (force) clearTimeout(force)
        spec.signal?.removeEventListener('abort', abort)
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(chunks.stdout).toString('utf8'),
          stderr: Buffer.concat(chunks.stderr).toString('utf8'),
          durationMs: Date.now() - started,
          truncated,
          ...(failure ? { failure } : {}),
          ...(child.pid ? { pid: child.pid } : {}),
        })
      }

      const abort = () => {
        failure = new Error('command was cancelled')
        killGroup(child)
        force = setTimeout(() => settle(null, null), 500)
      }

      // The profile goes through fd 3: no temp file, nothing in `ps`.
      const writer = child.stdio[3]
      if (writer && 'end' in writer) {
        ;(writer as NodeJS.WritableStream).end(profile)
      }

      child.stdout?.on('data', (data: Buffer) => collect('stdout', data))
      child.stderr?.on('data', (data: Buffer) => collect('stderr', data))
      child.on('error', (error) => {
        failure = error
        settle(null, null)
      })
      child.on('close', (code, signal) => {
        this.children.delete(spec.runId)
        settle(code, signal)
      })

      timer = setTimeout(() => {
        failure = new Error(`command timed out after ${spec.timeoutMs}ms`)
        killGroup(child)
        force = setTimeout(() => settle(null, null), 500)
      }, spec.timeoutMs)

      if (spec.signal?.aborted) abort()
      else spec.signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function probeSpec(root: string) {
  return { cwd: root, timeoutMs: 5_000, maxOutputBytes: 4_096, runId: `probe-${Date.now()}` }
}

function probePolicy(root: string, blockedDir: string): SandboxPolicy {
  return {
    id: 'self-check',
    version: 0,
    fs: {
      read: [{ path: root, recursive: true }],
      write: [{ path: root, recursive: true }],
      guardRead: [],
      guardWrite: [{ id: 'probe-guard', path: blockedDir, match: 'subpath', access: 'write', reason: 'probe' }],
    },
    net: { mode: 'deny', allow: [] },
    exec: { allowPaths: [] },
    limits: { timeoutMs: 5_000, maxOutputBytes: 4_096 },
  }
}

/**
 * Registers the Seatbelt provider.
 *
 * An object plugin (not a class) because `apply` may be async: Cordis awaits
 * the promise before the fiber becomes ACTIVE, so callers never observe a
 * provider whose probe suite has not finished. A class constructor cannot
 * provide that guarantee (its async effects run unawaited).
 */
const plugin = {
  name: 'sandbox-macos',
  inject: ['sandbox', 'sandboxPolicy'],
  Config: z.object({
    sandboxExec: z.string().default(SANDBOX_EXEC),
    selfCheck: z.boolean().default(true),
    execAllowPaths: z.array(z.string()).default([]),
    deniedExecutables: z.array(z.string()).default([...DEFAULT_DENIED_EXECUTABLES]),
    machLookup: z.union([z.const('allow'), z.const('deny')]).default('allow'),
    processInfo: z.union([z.const('allow'), z.const('deny')]).default('allow'),
    processFork: z.union([z.const('allow'), z.const('deny')]).default('allow'),
    probeRoot: z.string(),
  }),
  async apply(ctx: Context, config: Config = {}) {
    const provider = new SeatbeltProvider(config)
    const policy = ctx.get('sandboxPolicy', false) as { root: string } | undefined
    await provider.selfCheck(policy?.root ?? process.cwd())
    if (provider.failureReason) {
      ctx.logger('sandbox').error(provider.failureReason)
    } else {
      ctx.logger('sandbox').info('seatbelt provider ready (profile %s)', provider.extensions?.profileDigest)
    }
    const dispose = ctx.sandbox.registerProvider(provider)
    ctx.effect(() => async () => {
      dispose()
      await provider.destroyAll()
    }, 'sandbox.provider.darwin')
  },
}

export default plugin

export const meta = {
  title: 'macOS Seatbelt 沙箱',
  description: 'SBPL 动态生成与 sandbox-exec 执行。',
}
