/** Shared trajectory types: host projections and the browser snapshot share these. */

export interface ProjectionMeta {
  sessionId: string
  rev: number
  lastSeq: number
  updatedAt: number
}

export interface TurnTokens {
  input: number
  output: number
  cacheRead: number
}

export type TurnStatus = 'running' | 'done' | 'stopped' | 'error'

export interface TurnSummary {
  index: number
  title: string
  startedAt: number
  endedAt?: number
  status: TurnStatus
  recordCount: number
  toolCount: number
  stepCount: number
  tokens: TurnTokens
  firstSeq: number
  lastSeq: number
}

export type TrajectoryRecordKind =
  | 'system' | 'user' | 'context' | 'compacted'
  | 'assistant' | 'tool' | 'subtool'
  | 'memory' | 'wiki'

export interface RecordTiming {
  startedAt?: number
  firstTokenAt?: number
  completedAt?: number
}

export interface TrajectoryRecord {
  id: string
  seq: number
  turn: number
  step: number
  kind: TrajectoryRecordKind
  time: number
  preview: string
  detail?: string
  timing?: RecordTiming
  usage?: Partial<TurnTokens>
  callId?: string
  toolName?: string
  isError?: boolean
  source?: { kind?: string; name?: string }
}

export interface TimingSpan {
  recordId: string
  kind: TrajectoryRecordKind
  startedAt?: number
  firstTokenAt?: number
  completedAt?: number
}

export interface UsageEntry {
  turn: number
  step: number
  input: number
  output: number
  cacheRead: number
}

export interface TrajectorySnapshot {
  sessionId: string
  rev: number
  lastSeq: number
  generatedAt: number
  turns: TurnSummary[]
  records: TrajectoryRecord[]
  timing: TimingSpan[]
  usage: UsageEntry[]
  hasMore: boolean
  beforeTurn: number | null
}

export interface TrajectoryFrame {
  sessionId: string
  rev: number
  lastSeq: number
  turns: TurnSummary[]
  records: TrajectoryRecord[]
}
