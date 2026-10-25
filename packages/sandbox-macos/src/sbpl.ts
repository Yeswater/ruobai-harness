import { createHash } from 'node:crypto'
import type { Exemption, NetRule, PathGrant, PathGuard, SandboxPolicy } from '@ruobai/sandbox'

/** Escapes a path for a double-quoted SBPL string literal. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Glob → POSIX-extended regex source: `*` stops at `/`, `**` crosses. */
export function globSource(pattern: string): string {
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
    } else if ('.+^${}()|[]\\'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return `${source}$`
}

function grantFilter(grant: PathGrant): string {
  const path = quote(grant.path)
  return grant.recursive ? `(subpath ${path})` : `(literal ${path})`
}

/**
 * A single SBPL filter for a guard. `glob` guards become regex filters
 * because Seatbelt has no glob operator.
 */
export function guardFilter(guard: PathGuard): string {
  if (guard.match === 'subpath') return `(subpath ${quote(guard.path)})`
  if (guard.match === 'exact') return `(literal ${quote(guard.path)})`
  return `(regex #"${globSource(guard.path)}")`
}

export function exempted(guard: PathGuard, relax: readonly Exemption[] = []): boolean {
  return relax.some(entry =>
    (entry.kind === 'guard-read' && guard.access === 'read' && entry.guard === guard.id)
    || (entry.kind === 'guard-write' && guard.access === 'write' && entry.guard === guard.id),
  )
}

/**
 * Whether Seatbelt can enforce an allowlist host.
 *
 * Measured on macOS 26.6.2: `remote ip`/`remote tcp` accept **only** `*` or
 * `localhost`. Any other host — a domain or a numeric address — makes
 * `sandbox-exec` reject the whole profile at apply time with
 * `host must be * or localhost in network address` (exit 65), so the command
 * never starts. Per-host allowlisting therefore cannot be expressed here; the
 * narrowest usable grant is `*` scoped by port (appendix A28).
 */
export function isSupportedNetHost(host: string): boolean {
  return host === '*' || host === 'localhost'
}

/** Keeps the first grant per path; read and write lists overlap by design. */
function dedupeGrants(grants: readonly PathGrant[]): PathGrant[] {
  const seen = new Set<string>()
  const out: PathGrant[] = []
  for (const grant of grants) {
    const key = `${grant.recursive ? 'r' : 'l'}:${grant.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(grant)
  }
  return out
}

/** Paths every sandboxed process needs; independent of the policy. */
const BASELINE_EXEC = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin']
const BASELINE_READ = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library/Apple',
  '/Library/Developer',
  // System log filters; reading them is part of ordinary logging setup.
  '/Library/Preferences/Logging',
  '/private/var/db/dyld',
  // Timezone data: `date`, locale setup and most runtimes read it on start.
  '/private/var/db/timezone',
  // Local installs: `/usr/local/git/bin/git` dlopens its dylibs from
  // `/usr/local/git/lib*`, and Homebrew does the same under /opt (A23).
  '/usr/local',
  '/opt/homebrew',
  '/private/etc/ssl',
  '/private/etc/resolv.conf',
  '/private/etc/hosts',
  '/private/etc/passwd',
  '/private/etc/protocols',
  '/private/etc/services',
  '/dev',
]

/**
 * Device nodes a process writes to while starting up.
 *
 * `dtracehelper` is opened by dyld/libSystem on every exec; denying it is
 * harmless but it shows up in the kernel log for *every* command, so it must be
 * allowed or every run looks like a boundary hit (see appendix A18).
 */
const BASELINE_WRITE_DEV = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/fd', '/dev/tty', '/dev/dtracehelper']

/** Executables that would let a command escape the intent of the sandbox. */
export const DEFAULT_DENIED_EXECUTABLES = [
  '/usr/bin/security',
  '/usr/bin/osascript',
  '/usr/bin/sudo',
  '/usr/bin/su',
  '/usr/bin/launchctl',
  '/usr/bin/crontab',
  '/usr/bin/setsid',
  '/usr/bin/nohup',
]

export interface CompileOptions {
  /** Extra paths allowed to exec (e.g. a toolchain outside /usr). */
  execAllowPaths?: readonly string[]
  /** `(deny process-exec (literal ...))` entries. */
  deniedExecutables?: readonly string[]
  /** Whether to allow mach lookups. Defaults to true for toolchain compatibility. */
  machLookup?: 'allow' | 'deny'
  /**
   * Whether to allow process-info syscalls. Must default to `allow`: even
   * curl traps when `process-info-pidinfo self` is denied (appendix A15).
   */
  processInfo?: 'allow' | 'deny'
  /**
   * Whether to allow fork. Must default to `allow`: under `(deny default)` a
   * shell cannot fork, so pipelines, `&&`, subshells and any tool that spawns
   * help (git, npm, node) fail with `fork: Operation not permitted` (A18).
   */
  processFork?: 'allow' | 'deny'
}

export interface CompiledProfile {
  text: string
  digest: string
  warnings: string[]
}

/**
 * Compiles the platform-independent policy into SBPL.
 *
 * Hard rules, asserted below: no `(allow default)`, `(deny default)` first,
 * and every non-exempted guard emits a deny filter. Verified against
 * `/usr/bin/sandbox-exec` on macOS 26.6.2 (see docs/sandbox-macos.md appendix A).
 */
export function compileProfile(
  policy: SandboxPolicy,
  relax: readonly Exemption[] = [],
  options: CompileOptions = {},
): CompiledProfile {
  const warnings: string[] = []
  const lines: string[] = ['(version 1)', '(deny default)', '']

  lines.push(';; platform baseline')
  // `(literal "/")` only: `(subpath "/")` would grant read on the whole disk.
  lines.push(`(allow file-read* (literal ${quote('/')}))`)
  for (const path of BASELINE_READ) lines.push(`(allow file-read* (subpath ${quote(path)}))`)
  // Metadata reads (`stat` on ancestors) are needed by every path resolution.
  lines.push('(allow file-read-metadata)')
  lines.push('(allow sysctl-read)')
  lines.push('(allow ipc-posix-shm)')
  if (options.machLookup !== 'deny') {
    lines.push('(allow mach-lookup)')
  } else {
    lines.push('(allow mach-lookup (global-name "com.apple.system.logger"))')
  }
  if (options.processInfo !== 'deny') lines.push('(allow process-info*)')
  // A sandbox without fork is unusable: `sh -c 'a | b'` cannot start `b`.
  if (options.processFork !== 'deny') lines.push('(allow process-fork)')
  // Signalling one's own children is part of ordinary process management:
  // test runners kill their workers, and any supervisor terminates what it
  // spawned. Scoped to `children` so a command cannot signal the harness, an
  // approval process, or another session (measured: `self` and `others` do not
  // work for this case).
  lines.push('(allow signal (target children))')

  // A writable directory implies executable: the agent can already drop a
  // script there, so refusing exec only breaks toolchains (pnpm's `.pnpm`
  // store, `node_modules/.bin`, build outputs) without containing anything —
  // `sh dropped.sh` or `node -e` bypass an exec allowlist anyway. The real
  // boundary is `deniedExecutables` below plus the file-write grants.
  const execPaths = [...new Set([
    ...BASELINE_EXEC,
    ...(options.execAllowPaths ?? []),
    ...policy.exec.allowPaths,
    ...policy.fs.write.map(grant => grant.path),
  ])]
  for (const path of execPaths) lines.push(`(allow process-exec* (subpath ${quote(path)}))`)

  lines.push('', ';; read/write grants')
  const writeGrants: PathGrant[] = [...policy.fs.write]
  const literalWrites: string[] = [...BASELINE_WRITE_DEV]
  for (const exempt of relax) {
    if (exempt.kind === 'write-root') {
      writeGrants.push({ path: exempt.path, recursive: true })
    } else if (exempt.kind === 'write-file') {
      // Exact-file relaxation: a single target never widens to its directory.
      literalWrites.push(exempt.path)
    }
  }
  // Writable implies readable (an agent must be able to read back a file it
  // wrote, e.g. under TMPDIR), and this run's relaxations are included so a
  // relaxed write target does not come back as an unreadable file.
  const readGrants = dedupeGrants([...policy.fs.read, ...writeGrants])
  if (readGrants.length) lines.push(`(allow file-read* ${readGrants.map(grantFilter).join(' ')})`)
  if (writeGrants.length) lines.push(`(allow file-write* ${writeGrants.map(grantFilter).join(' ')})`)
  lines.push(`(allow file-write* ${literalWrites.map(path => `(literal ${quote(path)})`).join(' ')})`)
  // dyld issues an ioctl on `/dev/dtracehelper` at start-up. Reading and
  // writing the device is not enough: without this the log probe reports an
  // `unknown` denial on *every* command, which reads as a boundary hit (A19).
  lines.push(`(allow file-ioctl (literal ${quote('/dev/dtracehelper')}))`)

  lines.push('', ';; guards (deny always outranks allow, in any order)')
  const emitGuards = (guards: readonly PathGuard[], access: 'read' | 'write') => {
    const relaxed = relax.filter(entry =>
      (access === 'read' && entry.kind === 'guard-read')
      || (access === 'write' && entry.kind === 'guard-write'))
    if (relaxed.length) {
      warnings.push(`relaxed ${access} guards: ${relaxed.map(entry => (entry as { guard: string }).guard).join(', ')}`)
    }
    const active = guards.filter(guard => !exempted(guard, relax))
    if (!active.length) return
    lines.push(`(deny file-${access}* ${active.map(guardFilter).join(' ')})`)
  }
  emitGuards(policy.fs.guardRead, 'read')
  emitGuards(policy.fs.guardWrite, 'write')

  lines.push('', ';; network')
  if (policy.net.mode === 'deny') {
    lines.push('(deny network*)')
  } else if (policy.net.mode === 'proxy') {
    const port = policy.platform?.proxyPort
    if (typeof port === 'number') {
      lines.push(`(deny network*)`, `(allow network-outbound (remote ip ${quote(`127.0.0.1:${port}`)}))`)
    } else {
      warnings.push('proxy mode without platform.proxyPort; falling back to deny')
      lines.push('(deny network*)')
    }
  } else {
    const rules: readonly NetRule[] = policy.net.allow
    if (!rules.length) warnings.push('allowlist mode with no rules behaves like deny')
    let enforced = 0
    for (const rule of rules) {
      if (!isSupportedNetHost(rule.host)) {
        // Fail closed: skipping the rule denies the traffic instead of
        // producing a profile that no command can even run under (A28).
        warnings.push(
          `allowlist entry "${rule.host}" cannot be enforced: Seatbelt accepts only "*" or "localhost"; `
          + 'the rule was skipped (use host "*" with a port to opt into a port-only grant)',
        )
        continue
      }
      lines.push(`(allow network-outbound (remote tcp ${quote(`${rule.host}:${rule.port ?? 443}`)}))`)
      enforced += 1
    }
    if (enforced) {
      // Name resolution talks to mDNSResponder over a unix socket, which is a
      // network-outbound operation of its own. Without it every hostname fails
      // to resolve even though the TCP rule is present (A28).
      lines.push(`(allow network-outbound (literal ${quote('/private/var/run/mDNSResponder')}))`)
    } else {
      lines.push('(deny network*)')
    }
  }

  lines.push('', ';; control plane')
  lines.push('(deny appleevent-send)')
  lines.push('(deny signal (target others))')
  if (options.processInfo === 'deny') lines.push('(deny process-info*)')
  if (options.processFork === 'deny') lines.push('(deny process-fork)')
  for (const path of options.deniedExecutables ?? DEFAULT_DENIED_EXECUTABLES) {
    lines.push(`(deny process-exec (literal ${quote(path)}))`)
  }
  lines.push(
    `(deny file-write* ${['/private/etc', '/System', '/Library'].map(path => `(subpath ${quote(path)})`).join(' ')})`,
  )

  const text = `${lines.join('\n')}\n`

  // --- compile-time invariants -------------------------------------------------
  if (!text.includes('(deny default)')) {
    throw new Error('compiled profile lost its (deny default) posture')
  }
  if (text.includes('(allow default)')) {
    throw new Error('compiled profile contains (allow default)')
  }
  if (!writeGrants.length) warnings.push('policy has no write grants; every write will be denied')
  for (const guard of [...policy.fs.guardRead, ...policy.fs.guardWrite]) {
    if (exempted(guard, relax)) continue
    // Every guard must be represented in the profile, otherwise a guard could
    // be "configured but never compiled" and fail silently.
    if (!text.includes(guardFilter(guard))) {
      throw new Error(`guard "${guard.id}" is missing from the compiled profile`)
    }
  }
  return { text, digest: createHash('sha256').update(text).digest('hex'), warnings }
}
