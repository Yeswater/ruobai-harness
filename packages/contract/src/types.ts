/** Wire types for the task contract; no node or cordis imports. */

export interface AcceptanceCheck {
  tool: 'bash' | 'test' | 'manual'
  command?: string
  expectExit?: number
  expectContains?: string
}

export interface AcceptanceItem {
  /** Stable id within the contract, matched by todo items and evidence. */
  id: string
  /** Observable user action → expected result, not an internal property. */
  criterion: string
  kind: 'auto' | 'manual'
  check?: AcceptanceCheck
}

export interface TaskContract {
  id: string
  title: string
  /** Customer or environment label; a heading for handoff artifacts. */
  customer?: string
  goals: string[]
  /** Explicit non-goals; they become the handoff runbook's known limits. */
  nonGoals: string[]
  acceptance: AcceptanceItem[]
  openedAt: number
  /** 1 on open, +1 per accepted amendment. */
  revision: number
}

export interface ContractState {
  /** The single contract still open; a closed one is read from the transcript. */
  open: TaskContract | null
  lastSeq: number
}
