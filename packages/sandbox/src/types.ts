/**
 * Platform-independent sandbox types.
 *
 * Nothing here mentions SBPL, seccomp or AppContainer: a provider translates
 * this intent into the platform mechanism. Everything a caller (the shell
 * pipeline, tool-fs, a future Linux backend) needs lives in this file.
 */

export interface PathGrant {
  path: string
  /** `false` renders as a literal grant instead of a subtree. */
  recursive: boolean
}

export type GuardMatch = 'exact' | 'subpath' | 'glob'
export type GuardAccess = 'read' | 'write'

export interface PathGuard {
  /** Stable id, e.g. `git-dir`, `ssh-keys`, `env-file`. */
  id: string
  path: string
  match: GuardMatch
  /** Which access this guard restricts. */
  access: GuardAccess
  /** Model-facing explanation; also used in approval cards. */
  reason: string
  /** Plugin that contributed the guard, for exact cleanup and the UI. */
  owner?: string
}

export type NetMode = 'deny' | 'allowlist' | 'proxy'

export interface NetRule {
  host: string
  port?: number
  protocol?: 'tcp' | 'udp'
}

export interface SandboxLimits {
  timeoutMs: number
  maxOutputBytes: number
}

/**
 * Immutable snapshot of what a session is allowed to do.
 *
 * `version` bumps whenever guards, grants or the network mode change; providers
 * key their compiled-profile cache on it so a stale profile can never be reused.
 */
export interface SandboxPolicy {
  id: string
  version: number
  fs: {
    read: readonly PathGrant[]
    write: readonly PathGrant[]
    guardRead: readonly PathGuard[]
    guardWrite: readonly PathGuard[]
  }
  net: {
    mode: NetMode
    allow: readonly NetRule[]
  }
  exec: {
    allowPaths: readonly string[]
  }
  limits: SandboxLimits
  /** Platform escape hatch. Only the matching provider reads it. */
  platform?: Readonly<Record<string, unknown>>
}

/**
 * A one-shot relaxation of the policy, used when a human approves an
 * escalation. `compile()` drops the matching deny rule; nothing else changes.
 */
export type Exemption =
  | { kind: 'guard-read'; guard: string }
  | { kind: 'guard-write'; guard: string }
  /** Exactly one path; never widened to its parent directory. */
  | { kind: 'write-file'; path: string; once: true }
  /** A whole subtree, only for an explicit policy-level relaxation. */
  | { kind: 'write-root'; path: string; once: true }

/**
 * Prefixes a `write-file` exemption may never reach.
 *
 * A denial on `/dev/dtracehelper` must not become "relax `/dev`": device nodes
 * and system directories are never a relaxation lever (threats T4/T5).
 */
export const NON_RELAXABLE_PREFIXES: readonly string[] = [
  '/dev',
  '/System',
  '/Library',
  '/usr',
  '/bin',
  '/sbin',
  '/private/etc',
  '/private/var/db',
  '/private/var/run',
]

/**
 * Toolchain roots. `/usr/bin/git` is an `xcrun` shim: it dlopens
 * `libxcrun.dylib` from the developer directory, so without a read grant there
 * `git` dies with `unable to load libxcrun ... file system sandbox blocked`
 * (appendix A22). Compilers and their SDKs need the same treatment.
 */
export const TOOLCHAIN_READ: readonly string[] = [
  '/Applications/Xcode.app/Contents/Developer',
  '/Library/Developer/CommandLineTools',
]

/** Only the bin directories get exec rights, not the whole developer tree. */
export const TOOLCHAIN_EXEC: readonly string[] = [
  '/Applications/Xcode.app/Contents/Developer/usr/bin',
  '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin',
  '/Library/Developer/CommandLineTools/usr/bin',
]

export interface SandboxSpec {
  runId: string
  command: string
  /** Absolute working directory. */
  cwd: string
  policy: SandboxPolicy
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
  relax?: readonly Exemption[]
  sessionId?: string
}

/** One permission denial as reported by the OS, not yet classified. */
export interface RawDenialRecord {
  /** Process that was denied; used to attribute records to a run. */
  pid?: number
  processName?: string
  /** Native operation, e.g. `file-read-data` or `network-outbound remote:*:443`. */
  operation: string
  target?: string
  at: number
}

export interface SandboxRunResult {
  runId: string
  /** `71` means sandbox-exec itself refused to exec (see appendix A1). */
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
  /** Raw evidence. Providers do not classify; `ctx.denial` does. */
  denials: readonly RawDenialRecord[]
  /** Process ids spawned for this run; used to attribute native log records. */
  pids?: readonly number[]
  /** Digest of the compiled profile, for audit and "same policy?" checks. */
  profileDigest?: string
}

export interface SandboxHandle {
  id: string
  providerId: string
  kind: 'run' | 'session'
  createdAt: number
}

export type Capability =
  | 'kernel-fs'
  | 'kernel-net'
  | 'kernel-exec'
  | 'native-denial-log'
  | 'process-scoped'
  | 'checked-in-process'

export interface PreparedPolicy {
  /** Platform text (SBPL for macOS). Never written to disk. */
  text: string
  digest: string
  warnings: readonly string[]
}

/**
 * A platform backend. **Not a Service**: it is registered into
 * `ctx.sandbox`'s provider table through `ctx.effect()`, so it has no name on
 * the context and must not be injected.
 */
export interface SandboxProvider {
  readonly platform: NodeJS.Platform
  readonly id: string
  readonly capabilities: ReadonlySet<Capability>
  /** False after a failed self-check; `ctx.sandbox.provider()` hides it. */
  readonly available: boolean
  readonly extensions?: Readonly<Record<string, unknown>>

  /** Pure and cacheable: one compilation per (policy.version, relax). */
  compile(policy: SandboxPolicy, relax?: readonly Exemption[]): Promise<PreparedPolicy>

  execute(spec: SandboxSpec, prepared: PreparedPolicy): Promise<SandboxRunResult>

  readFile(path: string, options: { encoding?: BufferEncoding }, handle: SandboxHandle): Promise<Buffer | string>
  writeFile(path: string, data: string | Uint8Array, options: { mode?: number }, handle: SandboxHandle): Promise<void>

  /** Idempotent: kills every process group of this handle and frees its cache. */
  destroy(handle: SandboxHandle): Promise<void>
  destroyAll(): Promise<void>
}

export class SandboxUnavailableError extends Error {
  constructor(platform: string = process.platform) {
    super(`no sandbox provider is available for platform "${platform}"; refusing to run unconfined`)
    this.name = 'SandboxUnavailableError'
  }
}

/**
 * `sandbox-exec` cannot be nested: applying a profile from inside an existing
 * one fails with `sandbox_apply: Operation not permitted` (exit 71). This
 * matters when the harness itself runs under `bin/rbu-jail`.
 */
export class NestedSandboxError extends Error {
  constructor(detail = 'this process is already inside a Seatbelt profile') {
    super(`cannot nest sandbox-exec: ${detail}; run the harness outside the jail or switch to shell-direct`)
    this.name = 'NestedSandboxError'
  }
}

export class PathGuardError extends Error {
  constructor(readonly guard: PathGuard, readonly target: string, readonly access: GuardAccess) {
    super(`[sandbox] ${access} on ${target} is blocked by guard "${guard.id}": ${guard.reason}`)
    this.name = 'PathGuardError'
  }
}
