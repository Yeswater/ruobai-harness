/** Wire types shared with the settings panel (no node or cordis imports). */

export type HookLayer = 'edit' | 'stop' | 'audit' | 'deliver'

export interface DiagnosticView {
  path: string
  line?: number
  column?: number
  rule: string
  level: 'error' | 'warn'
  message: string
  suggestion?: string
  fingerprint: string
  baseline?: boolean
}

export interface CheckerView {
  id: string
  exitCode: number | null
  durationMs: number
  error?: string
}

export interface HookRunView {
  id: string
  at: number
  layer: HookLayer
  sessionId?: string
  blocked: boolean
  escalated?: boolean
  fresh: number
  total: number
  durationMs: number
  checkers: CheckerView[]
  diagnostics: DiagnosticView[]
}

export interface HookMetricsView {
  runs: number
  passes: number
  blocks: number
  escalations: number
  violations: number
  averageDurationMs: number
  lastRunAt?: number
  lastBlockAt?: number
}

export interface HookCheckerInfo {
  id: string
  scope: 'edit' | 'stop'
  command: string
  writes: boolean
  enabled: boolean
}

export interface HookStatusView {
  enabled: boolean
  layers: {
    edit: boolean
    stop: boolean
    audit: boolean
    deliver: boolean
  }
  metrics: HookMetricsView
  checkers: HookCheckerInfo[]
  /** Baseline protections; settings may add to them. */
  guard: { denyWrite: string[]; denyCommand: string[] }
  lastRun?: HookRunView
}
