/** Diagnostics shared by every checker and by the hook layers that consume them. */

export type DiagnosticLevel = 'error' | 'warn'

export type CheckScope = 'edit' | 'stop'

export interface Diagnostic {
  /** Workspace-relative path, for a stable fingerprint across machines. */
  path: string
  line?: number
  column?: number
  rule: string
  level: DiagnosticLevel
  message: string
  /** Concrete fix or example, when the checker provides one. */
  suggestion?: string
  docs?: string
  fingerprint: string
}

export type CheckerParser = 'biome' | 'tsc' | 'plain'

export interface CheckerConfig {
  id: string
  scope: CheckScope
  /** Shell command; `scope: 'edit'` appends the changed files. */
  command: string
  parser?: CheckerParser
  /** A formatter may rewrite files; linters never do. */
  writes?: boolean
  /**
   * Shell executor id. Harness-owned checks use the host executor so they are
   * not affected by the agent's sandbox; unset means the default executor.
   */
  executor?: string
  timeoutMs?: number
  enabled?: boolean
}

export interface CheckInput {
  scope: CheckScope
  /** Files touched by the edit that triggered this run. */
  files?: string[]
  /** Directory the commands run in. */
  cwd: string
  /** Workspace root, used to resolve the baseline and normalize paths. */
  root: string
  sessionId?: string
  signal?: AbortSignal
}

export interface CheckerReport {
  id: string
  exitCode: number | null
  durationMs: number
  error?: string
}

export interface CheckResult {
  diagnostics: Diagnostic[]
  checkers: CheckerReport[]
  durationMs: number
}

export type PartitionKind = 'fresh' | 'worsened' | 'known'

export interface Partition {
  fresh: Diagnostic[]
  worsened: Diagnostic[]
  known: Diagnostic[]
  /** Diagnostics that must fail the gate. */
  blocking: Diagnostic[]
}
