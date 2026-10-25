import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import type { GuardAccess, RawDenialRecord, SandboxRunResult } from '@ruobai/sandbox'

export type DenialKind =
  | 'fs-read-guarded'
  | 'fs-write-guarded'
  | 'fs-write-outside'
  | 'network-outbound'
  | 'process-exec'
  | 'process-control'
  | 'mach-lookup'
  | 'appleevent'
  | 'unknown'

export type DenialEvidence = 'native-log' | 'stderr' | 'exit-code' | 'heuristic'
export type DenialConfidence = 'high' | 'medium' | 'low'

export interface Denial {
  id: string
  runId: string
  sessionId?: string
  kind: DenialKind
  /** Raw SBPL operation, for audit only. Never branch on this. */
  operation?: string
  target?: string
  /** Guard id when the target could be attributed to one. */
  guard?: string
  evidence: DenialEvidence
  confidence: DenialConfidence
  /** sha1(kind + normalized target + command family). */
  fingerprint: string
  repeated: number
  command: string
  exitCode: number | null
  at: number
  /** Model-facing one-liner. */
  message: string
}

export interface DenialRunContext {
  command: string
  sessionId?: string
  cwd?: string
}

export interface Config {
  /** Window for repeat detection. */
  repeatWindowMs?: number
  /** Number of occurrences that counts as repeating. */
  repeatThreshold?: number
  /** How long raw native records are kept for attribution. */
  logWindowMs?: number
  /** How many denials to keep for the status panel. Defaults to 50. */
  historyLimit?: number
}

const NETWORK_TOOLS = /^(curl|wget|nc|ncat|telnet|ssh|scp|sftp|ping|dig|host|nslookup)$/
const NETWORK_SUBCOMMANDS = /\b(git (clone|fetch|pull|push|ls-remote)|npm (install|i|ci|publish)|pnpm (install|i|add)|yarn (add|install)|pip3? (install|download)|cargo (fetch|install)|go (get|mod download))\b/

/**
 * Denials that do not change what the command can do.
 *
 * Every exec probes a handful of things (sysctl, inode metadata, the debug
 * channel on `/dev/dtracehelper`, process info). Under `(deny default)` those
 * probes are denied and logged, so they would otherwise look like a boundary
 * hit on *every* command and turn the escalation path into a prompt on every
 * step. They are filtered here and never reach `escalation`.
 */
const NOISE_OPERATIONS = [
  'sysctl-read',
  'file-read-metadata',
  'process-info',
  'mach-lookup',
  'network-outbound /private/var/run/syslog',
]
const NOISE_TARGETS = ['/dev/dtracehelper', '/dev/urandom', '/dev/random', '/var/run/syslog', '/private/var/run/syslog']

export function isNoise(operation: string, target?: string): boolean {
  if (NOISE_OPERATIONS.some(prefix => operation.startsWith(prefix))) return true
  // npm/node read the *global* defaults domain on start-up (`npx --version`
  // alone triggers it). A Seatbelt filter for this operation does not match,
  // so the read stays denied — but it is a probe, not a boundary hit. Only
  // the global domain is filtered: per-app preferences may hold tokens.
  if (operation.startsWith('user-preference-read') && target === 'kcfpreferencesanyapplication') return true
  if (target && NOISE_TARGETS.some(known => target === known || target.startsWith(`${known} `))) return true
  // A write to any /dev node is a start-up probe, not a data operation.
  if (target && target.startsWith('/dev/') && (operation.startsWith('file-write') || operation.startsWith('file-create'))) {
    return true
  }
  return false
}

export function commandFamily(command: string): string {
  const first = command.trim().split(/[\s;|&]+/)[0] ?? ''
  return basename(first)
}

/** Maps a native SBPL operation to a platform-neutral kind. */
export function kindOfOperation(operation: string, guarded: boolean): DenialKind {
  if (operation.startsWith('file-read')) return 'fs-read-guarded'
  if (operation.startsWith('file-write') || operation.startsWith('file-create')) {
    return guarded ? 'fs-write-guarded' : 'fs-write-outside'
  }
  if (operation.startsWith('network')) return 'network-outbound'
  if (operation.startsWith('process-exec')) return 'process-exec'
  if (operation.startsWith('process-info') || operation.startsWith('signal')) return 'process-control'
  if (operation.startsWith('mach-lookup')) return 'mach-lookup'
  if (operation.startsWith('appleevent')) return 'appleevent'
  return 'unknown'
}

export function accessOfKind(kind: DenialKind): GuardAccess | undefined {
  if (kind === 'fs-read-guarded') return 'read'
  if (kind === 'fs-write-guarded' || kind === 'fs-write-outside') return 'write'
  return undefined
}

/** Parses `Sandbox: cat(11293) deny(1) file-read-data /Users/x/.ssh/id_rsa`. */
export function parseLogRecord(line: string): RawDenialRecord | undefined {
  const match = /Sandbox:\s+(\S+?)\((\d+)\)\s+deny\(\d+\)\s+(\S+)(?:\s+(.*))?$/.exec(line)
  if (!match) return undefined
  const [, processName, pid, operation, target] = match
  return {
    pid: Number(pid),
    processName,
    operation,
    ...(target ? { target: target.trim() } : {}),
    at: Date.now(),
  }
}

function describe(kind: DenialKind, target: string | undefined, guard: string | undefined) {
  const what = target ? ` ${target}` : ''
  switch (kind) {
    case 'fs-read-guarded':
      return `[sandbox] 读取${what}被 macOS Seatbelt 拒绝（guard: ${guard ?? 'unknown'}）`
    case 'fs-write-guarded':
      return `[sandbox] 写入${what}被 macOS Seatbelt 拒绝（guard: ${guard ?? 'unknown'}）`
    case 'fs-write-outside':
      return `[sandbox] 写入${what}越出写白名单，被 macOS Seatbelt 拒绝`
    case 'network-outbound':
      return `[sandbox] 出站网络连接被 macOS Seatbelt 拒绝（网络默认关闭）`
    case 'process-exec':
      return '[sandbox] 进程执行被 macOS Seatbelt 拒绝'
    case 'process-control':
      return '[sandbox] 进程控制（signal/进程信息）被 macOS Seatbelt 拒绝'
    case 'mach-lookup':
      return '[sandbox] mach 服务查找被 macOS Seatbelt 拒绝'
    case 'appleevent':
      return '[sandbox] AppleEvent 自动化被 macOS Seatbelt 拒绝'
    default:
      return `[sandbox] 操作${what}被 macOS Seatbelt 拒绝`
  }
}

declare module '@ruobai/cordis' {
  interface Context {
    denial: DenialService
  }

  interface Events {
    'sandbox/denied'(denial: Denial): void
    'sandbox/denial-repeated'(denial: Denial): void
    'sandbox/denial-record'(record: RawDenialRecord): void
  }
}

/**
 * Classifies denials and owns the evidence needed to attribute them.
 *
 * Independent of `approval` on purpose: the approval plane must not appear in
 * the sandbox plugin's dependency graph (a cycle leaves both fibers PENDING
 * forever, with no error in the log).
 */
export class DenialService extends Service {
  static inject: string[] = []

  private readonly fingerprints = new Map<string, { count: number; firstAt: number; generation: number }>()
  private readonly records: Array<RawDenialRecord & { generation: number }> = []
  /** Bounded history for the UI. Kept separate from `records`, whose TTL is
   *  tuned for attribution (seconds), not for display (minutes). */
  private readonly history: Denial[] = []
  private generation = 0
  private sweep: ReturnType<typeof setInterval> | undefined
  private readonly config: Required<Config> & { historyLimit: number }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'denial')
    this.config = {
      repeatWindowMs: config.repeatWindowMs ?? 300_000,
      repeatThreshold: config.repeatThreshold ?? 2,
      logWindowMs: config.logWindowMs ?? 15_000,
      historyLimit: config.historyLimit ?? 50,
    }
    ctx.effect(() => {
      this.sweep = setInterval(() => this.evict(), Math.min(this.config.repeatWindowMs, 60_000))
      if (typeof this.sweep.unref === 'function') this.sweep.unref()
      return () => {
        if (this.sweep) clearInterval(this.sweep)
        this.sweep = undefined
        // Dropping the tables on unload is what keeps a hot reload from
        // inheriting stale repeat counters (which would reject escalations).
        this.fingerprints.clear()
        this.records.length = 0
        this.history.length = 0
        this.generation++
      }
    }, 'sandbox-denial.dispose')
  }

  /** Feeds a native log record (from the log-stream probe plugin). */
  ingest(record: RawDenialRecord): void {
    this.records.push({ ...record, generation: this.generation })
    if (this.records.length > 1_000) this.records.splice(0, this.records.length - 1_000)
    this.ctx.emit('sandbox/denial-record', record)
  }

  currentGeneration(): number {
    return this.generation
  }

  /**
   * Turns a finished run into typed denials.
   *
   * Evidence order matters: native log (high) beats stderr (medium), which
   * beats exit code (weak). With no log probe the result is explicitly
   * low-confidence so escalation can require a human instead of guessing.
   */
  classify(result: SandboxRunResult, run: DenialRunContext): Denial[] {
    const denials: Denial[] = []
    const seen = new Set<string>()
    const pids = new Set(result.pids ?? [])
    const windowStart = Date.now() - this.config.logWindowMs

    const natives = [
      ...result.denials,
      ...this.records.filter(record =>
        record.generation === this.generation
        && record.at >= windowStart
        && (pids.size === 0 || (record.pid !== undefined && pids.has(record.pid)))),
    ]

    for (const record of natives) {
      // Start-up probes are logged for every process; they must not be read as
      // a boundary hit (appendix A18).
      if (isNoise(record.operation, record.target)) continue
      const access = record.operation.startsWith('file-read')
        ? 'read'
        : record.operation.startsWith('file-') ? 'write' : undefined
      const guard = record.target && access ? this.guardFor(record.target, access) : undefined
      const kind = kindOfOperation(record.operation, Boolean(guard))
      const key = `${kind}:${record.target ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      denials.push(this.make(kind, {
        operation: record.operation,
        target: record.target,
        guard,
        evidence: 'native-log',
        confidence: 'high',
        run,
        result,
      }))
    }

    if (!denials.length) {
      const execMatch = /sandbox-exec: execvp\(\) of '(.+?)' failed: Operation not permitted/.exec(result.stderr)
      if (execMatch || result.exitCode === 71) {
        denials.push(this.make('process-exec', {
          target: execMatch?.[1],
          evidence: execMatch ? 'stderr' : 'exit-code',
          confidence: execMatch ? 'high' : 'medium',
          run,
          result,
        }))
      } else if (this.looksLikeNetworkFailure(run.command, result)) {
        // Network denials leave no trace in the child at all (appendix A7):
        // curl exits 7, nc exits 1, stderr is empty. Only the command family
        // and exit code give us a hint, hence low confidence.
        denials.push(this.make('network-outbound', {
          evidence: 'heuristic',
          confidence: 'low',
          run,
          result,
        }))
      } else if (/Operation not permitted|Permission denied/.test(result.stderr) || result.exitCode === 1) {
        // Without a log probe we cannot prove the sandbox caused this, so the
        // confidence stays low. We still attribute statically (path tokens in
        // the command against the guard table) because an unattributed denial
        // can never be turned into a minimal exemption, which would make
        // escalation unreachable instead of merely conservative.
        const inferred = this.inferFromCommand(run.command, run.cwd)
        const kind = inferred
          ? (inferred.access === 'read' ? 'fs-read-guarded' as const : 'fs-write-guarded' as const)
          : this.heuristicKind(run.command, result)
        denials.push(this.make(kind, {
          target: inferred?.target,
          guard: inferred?.guard,
          evidence: 'heuristic',
          confidence: 'low',
          run,
          result,
        }))
      }
    }

    for (const denial of denials) {
      const entry = this.record(denial.fingerprint)
      this.pushHistory(denial)
      this.ctx.emit('sandbox/denied', denial)
      if (denial.repeated >= this.config.repeatThreshold) {
        this.ctx.emit('sandbox/denial-repeated', denial)
      }
      void entry
    }
    return denials
  }

  isRepeating(fingerprint: string): boolean {
    const entry = this.fingerprints.get(fingerprint)
    return Boolean(entry && entry.count >= this.config.repeatThreshold)
  }

  /**
   * Most recent denials, newest first.
   *
   * Read-only projection for the status panel: it answers "what did the
   * sandbox actually block", which is the question a user has when a command
   * fails for reasons the model cannot explain.
   */
  recent(limit = this.config.historyLimit): Denial[] {
    return this.history.slice(-Math.max(1, limit)).reverse()
  }

  /** Counts per kind, for the summary line. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const denial of this.history) out[denial.kind] = (out[denial.kind] ?? 0) + 1
    return out
  }

  /** Test/diagnostic hook: forget all repeat counters. */
  reset(): void {
    this.fingerprints.clear()
    this.records.length = 0
    this.history.length = 0
    this.generation++
  }

  /** curl(6,7,28,35), nc(1), git(128) style network failures with no stderr. */
  private looksLikeNetworkFailure(command: string, result: SandboxRunResult): boolean {
    const family = commandFamily(command)
    const networkCommand = NETWORK_TOOLS.test(family) || NETWORK_SUBCOMMANDS.test(command)
    if (!networkCommand) return false
    if (!result.stderr.trim()) return true
    return /Could not resolve|Failed to connect|Network is unreachable|Operation not permitted/.test(result.stderr)
  }

  /**
   * Static attribution: split the command into tokens, resolve each path-like
   * token against cwd, and ask the policy which guard it hits. Weak evidence,
   * but it yields the `guard` an exemption needs.
   */
  private inferFromCommand(command: string, cwd?: string): { target: string; guard: string; access: GuardAccess } | undefined {
    const tokens = command.split(/[\s;|&<>()]+/).filter(Boolean)
    for (const raw of tokens) {
      const token = raw.replace(/^['"]|['"]$/g, '')
      if (!token || token.startsWith('-') || !/[./]/.test(token)) continue
      let path: string
      if (token === '~' || token.startsWith('~/')) {
        path = join(homedir(), token.slice(1).replace(/^\//, ''))
      } else if (isAbsolute(token)) {
        path = token
      } else {
        path = resolve(cwd ?? process.cwd(), token)
      }
      for (const access of ['read', 'write'] as const) {
        const guard = this.guardFor(path, access)
        if (guard) return { target: path, guard, access }
      }
    }
    return undefined
  }

  private heuristicKind(command: string, result: SandboxRunResult): DenialKind {
    const family = commandFamily(command)
    if (NETWORK_TOOLS.test(family) || NETWORK_SUBCOMMANDS.test(command)) return 'network-outbound'
    if (result.exitCode === 126 || result.exitCode === 127) return 'process-exec'
    return 'unknown'
  }

  private guardFor(target: string, access: GuardAccess): string | undefined {
    const policy = this.ctx.get('sandboxPolicy', false) as
      | { guardFor(path: string, access?: GuardAccess): string | undefined }
      | undefined
    try {
      return policy?.guardFor(target, access)
    } catch {
      return undefined
    }
  }

  /** Appends to the display history, dropping the oldest beyond the limit. */
  private pushHistory(denial: Denial) {
    this.history.push(denial)
    if (this.history.length > this.config.historyLimit) {
      this.history.splice(0, this.history.length - this.config.historyLimit)
    }
  }

  private record(fingerprint: string): { count: number } {
    const now = Date.now()
    const entry = this.fingerprints.get(fingerprint)
    if (!entry || now - entry.firstAt > this.config.repeatWindowMs) {
      this.fingerprints.set(fingerprint, { count: 1, firstAt: now, generation: this.generation })
      return { count: 1 }
    }
    entry.count++
    return entry
  }

  private evict() {
    const now = Date.now()
    for (const [key, entry] of this.fingerprints) {
      if (entry.generation !== this.generation || now - entry.firstAt > this.config.repeatWindowMs) {
        this.fingerprints.delete(key)
      }
    }
    const windowStart = now - this.config.logWindowMs
    while (this.records.length && this.records[0].at < windowStart) this.records.shift()
  }

  private make(
    kind: DenialKind,
    input: {
      operation?: string
      target?: string
      guard?: string
      evidence: DenialEvidence
      confidence: DenialConfidence
      run: DenialRunContext
      result: SandboxRunResult
    },
  ): Denial {
    const fingerprint = createHash('sha1')
      .update(`${kind}|${input.target ?? ''}|${commandFamily(input.run.command)}`)
      .digest('hex')
    const existing = this.fingerprints.get(fingerprint)
    const repeated = (existing?.count ?? 0) + 1
    return {
      id: randomUUID(),
      runId: input.result.runId,
      sessionId: input.run.sessionId,
      kind,
      operation: input.operation,
      target: input.target,
      guard: input.guard,
      evidence: input.evidence,
      confidence: input.confidence,
      fingerprint,
      repeated,
      command: input.run.command,
      exitCode: input.result.exitCode,
      at: Date.now(),
      message: describe(kind, input.target, input.guard),
    }
  }
}

export default DenialService

export const meta = {
  title: '沙箱拒绝分类',
  description: '把 Seatbelt 拒绝归因为类型化 denial 事件。',
}
