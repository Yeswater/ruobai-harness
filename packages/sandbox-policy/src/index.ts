import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize as normalizePath, resolve, sep } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import {
  PathGuardError,
  TOOLCHAIN_READ,
  type GuardAccess,
  type NetMode,
  type NetRule,
  type PathGrant,
  type PathGuard,
  type SandboxPolicy,
} from '@ruobai/sandbox'

export interface Config {
  /** Workspace root; the only write grant besides the temp directory. */
  root?: string
  network?: { mode?: NetMode; allow?: NetRule[] }
  limits?: { timeoutMs?: number; maxOutputBytes?: number }
  exec?: { allowPaths?: string[] }
  /** Extra read grants, e.g. a shared cache directory. */
  extraRead?: string[]
  /** Extra write grants. Off by default: writes stay inside the workspace. */
  extraWrite?: string[]
  /** Per-run temp directory grant. Defaults to the process TMPDIR. */
  tempRoot?: string
  /**
   * When true, `full-access` sessions also get a write grant on the home
   * directory. Off by default: the sandbox stays a hard boundary and the
   * permission mode only affects approvals.
   */
  allowFullAccessWrite?: boolean
  /** Grant read access to the Xcode / CommandLineTools roots. Defaults to on. */
  toolchain?: boolean
}

export interface PolicyRequest {
  sessionId?: string
}

/** Quote-free glob → RegExp: `*` stops at `/`, `**` crosses directories. */
export function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index++
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

/**
 * Canonical form used for every guard comparison.
 *
 * `realpath` first (a symlink must not borrow a grant), NFC second (APFS
 * stores NFD while user input is usually NFC), case folding last because the
 * default macOS volume is case-insensitive.
 */
export function canonicalPath(path: string): string {
  const resolved = isAbsolute(path) ? path : resolve(path)
  // Resolve the deepest existing ancestor and re-append the rest: a write
  // target usually does not exist yet, but its parent may be a symlink that
  // points at a guarded directory.
  let current = resolved
  const rest: string[] = []
  let base = resolved
  for (;;) {
    try {
      base = realpathSync(current)
      break
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        base = normalizePath(resolved)
        rest.length = 0
        break
      }
      rest.unshift(basename(current))
      current = parent
    }
  }
  const joined = rest.length ? join(base, ...rest) : base
  const folded = process.platform === 'darwin' ? joined.toLowerCase() : joined
  return folded.normalize('NFC')
}

export function guardMatches(guard: PathGuard, target: string): boolean {
  const path = canonicalPath(guard.path)
  const value = canonicalPath(target)
  if (guard.match === 'exact') return value === path
  if (guard.match === 'subpath') return value === path || value.startsWith(path.endsWith(sep) ? path : path + sep)
  try {
    return globToRegExp(path).test(value)
  } catch {
    return false
  }
}

export interface GitPaths {
  /** The worktree's own git dir (index, HEAD for a linked worktree). */
  gitDir: string
  /** Shared git dir (objects, refs, logs, hooks, config). */
  commonDir: string
}

/**
 * Resolve the real git directories for a workspace that may be a linked
 * worktree. A normal checkout has `<root>/.git` as a directory; a linked
 * worktree has a `.git` file pointing at `<common>/worktrees/<name>`.
 */
export function resolveGitPaths(root: string): GitPaths | undefined {
  const dotGit = join(root, '.git')
  let info
  try {
    info = statSync(dotGit)
  } catch {
    return undefined
  }
  if (info.isDirectory()) return { gitDir: dotGit, commonDir: dotGit }
  if (!info.isFile()) return undefined

  let text: string
  try {
    text = readFileSync(dotGit, 'utf8').trim()
  } catch {
    return undefined
  }
  const match = /^gitdir:\s*(.+)$/.exec(text)
  if (!match) return undefined

  const gitDir = isAbsolute(match[1]!) ? match[1]! : resolve(root, match[1]!)
  let commonDir = gitDir
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    if (common) commonDir = isAbsolute(common) ? common : resolve(gitDir, common)
  } catch {
    // Not a linked worktree.
  }
  return { gitDir: resolve(gitDir), commonDir: resolve(commonDir) }
}

declare module '@ruobai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }

  interface Events {
    'sandbox/policy-changed'(version: number, reason: string): void
  }
}

/**
 * Builds the platform-independent policy and is the in-process execution
 * point for the same guard table the Seatbelt profile is compiled from.
 */
export class SandboxPolicyService extends Service {
  static inject: string[] = []

  private readonly config: Required<Pick<Config, 'extraRead' | 'extraWrite' | 'allowFullAccessWrite'>> & Config
  private readonly guards = new Map<string, PathGuard>()
  private version = 1

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sandboxPolicy')
    this.config = {
      ...config,
      extraRead: config.extraRead ?? [],
      extraWrite: config.extraWrite ?? [],
      allowFullAccessWrite: config.allowFullAccessWrite ?? false,
    }
    ctx.effect(() => () => {
      this.guards.clear()
      this.version++
    }, 'sandbox-policy.dispose')
  }

  get root(): string {
    return resolve(this.config.root ?? process.cwd())
  }

  get network(): { mode: NetMode; allow: readonly NetRule[] } {
    return { mode: this.config.network?.mode ?? 'deny', allow: this.config.network?.allow ?? [] }
  }

  currentVersion(): number {
    return this.version
  }

  /**
   * Register a guard. The disposer removes the entry and bumps the version so
   * compiled profiles and cached evaluations cannot outlive the plugin.
   */
  registerGuard(guard: PathGuard): () => void {
    const key = guard.id
    const existed = this.guards.get(key)
    this.guards.set(key, guard)
    this.version++
    this.ctx.emit('sandbox/policy-changed', this.version, `guard:${key}`)
    return () => {
      if (this.guards.get(key) !== guard) return
      if (existed) this.guards.set(key, existed)
      else this.guards.delete(key)
      this.version++
      this.ctx.emit('sandbox/policy-changed', this.version, `guard:${key}`)
    }
  }

  listGuards(): PathGuard[] {
    return [...this.guards.values()]
  }

  /** Longest matching guard for a path, or undefined. */
  attribute(path: string, access?: GuardAccess): PathGuard | undefined {
    let best: PathGuard | undefined
    let bestLength = -1
    for (const guard of this.guards.values()) {
      if (access && guard.access !== access) continue
      if (!guardMatches(guard, path)) continue
      const length = canonicalPath(guard.path).length
      if (length > bestLength) {
        best = guard
        bestLength = length
      }
    }
    return best
  }

  /** Throws `PathGuardError` when the path hits a guard. */
  check(path: string, access: GuardAccess = 'write'): void {
    const guard = this.attribute(path, access)
    if (guard) throw new PathGuardError(guard, path, access)
  }

  /** Non-throwing form used by denial attribution. */
  guardFor(path: string, access?: GuardAccess): string | undefined {
    return this.attribute(path, access)?.id
  }

  /**
   * Immutable snapshot for one session. The shell pipeline takes one snapshot
   * per run, so a mid-run policy change cannot produce a half-applied profile.
   */
  forSession(request: PolicyRequest = {}): SandboxPolicy {
    const mode = this.permissionMode(request.sessionId)
    const root = this.root
    const home = process.env.HOME ?? ''
    const writeGrants: PathGrant[] = [{ path: root, recursive: true }]
    const tempRoot = this.config.tempRoot ?? tmpdir()
    if (tempRoot) writeGrants.push({ path: tempRoot, recursive: true })
    for (const extra of this.config.extraWrite) writeGrants.push({ path: resolve(extra), recursive: true })
    if (mode === 'full-access' && this.config.allowFullAccessWrite && home) {
      writeGrants.push({ path: home, recursive: true })
    }

    const readGrants: PathGrant[] = [{ path: root, recursive: true }]
    for (const extra of this.config.extraRead) readGrants.push({ path: resolve(extra), recursive: true })
    if (home) readGrants.push({ path: home, recursive: true })
    // `/usr/bin/git` is an xcrun shim that dlopens libxcrun from the developer
    // directory; without this, git (and every compiler) is unusable (A22).
    if (this.config.toolchain !== false) {
      for (const path of TOOLCHAIN_READ) {
        if (existsSync(path)) readGrants.push({ path, recursive: true })
      }
    }

    // A linked worktree writes its index/HEAD into its own git dir and the
    // objects/refs/logs into the common dir; both usually sit outside the
    // workspace root. The persistence guards still deny hooks/config there.
    const git = resolveGitPaths(root)
    if (git) {
      const inRoot = (path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
      for (const path of new Set([git.gitDir, git.commonDir])) {
        if (!inRoot(path)) writeGrants.push({ path, recursive: true })
        if (!readGrants.some(grant => grant.path === path)) {
          readGrants.push({ path, recursive: true })
        }
      }
    }

    const guards = this.listGuards()
    return Object.freeze({
      id: request.sessionId ? `session:${request.sessionId}` : 'workspace',
      version: this.version,
      fs: Object.freeze({
        read: readGrants,
        write: mode === 'read-only' ? [] : writeGrants,
        guardRead: guards.filter(guard => guard.access === 'read'),
        guardWrite: guards.filter(guard => guard.access === 'write'),
      }),
      net: this.network,
      exec: { allowPaths: this.config.exec?.allowPaths ?? [] },
      limits: {
        timeoutMs: this.config.limits?.timeoutMs ?? 120_000,
        maxOutputBytes: this.config.limits?.maxOutputBytes ?? 32_768,
      },
    }) as SandboxPolicy
  }

  private permissionMode(sessionId?: string): string {
    const permissions = this.ctx.get('permissions', false) as
      | { modeFor(sessionId?: string): string }
      | undefined
    try {
      return permissions?.modeFor(sessionId) ?? 'workspace-write'
    } catch {
      return 'workspace-write'
    }
  }
}

export default SandboxPolicyService

export const meta = {
  title: '沙箱策略',
  description: '平台无关策略 IR、路径守卫表与进程内检查点。',
}
