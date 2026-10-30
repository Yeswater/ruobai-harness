/** Wire types for delivery evidence; no node or cordis imports. */

export type Verdict = 'pass' | 'fail' | 'unsure'

export interface EvidenceRef {
  /**
   * `tool` points at a `tool/result` event by seq; `manual` is only valid with
   * a waiver. Evidence never copies content: the log is the single source.
   */
  kind: 'tool' | 'manual'
  /** For `tool`: the `tool/result` seq as a string. */
  ref: string
  /** Present for `tool` evidence; the seq is checked against the log. */
  seq?: number
  summary: string
}

export interface DeliveryClaimItem {
  acceptanceId: string
  claim: string
  evidence: EvidenceRef[]
}

export interface DeliveryClaim {
  contractId: string
  items: DeliveryClaimItem[]
  at: number
}

export interface DeliveryCheck {
  acceptanceId: string
  status: 'passed' | 'failed' | 'missing' | 'manual-pending'
  reason: string
  evidence: EvidenceRef[]
}

export interface DeliveryVerdict {
  contractId: string
  verdict: Verdict
  checks: DeliveryCheck[]
  at: number
  /** Why the verdict is not a plain pass/fail (no contract, gate unavailable). */
  reason?: string
}

export interface DeliveryState {
  claims: DeliveryClaim[]
  verdict?: DeliveryVerdict
  /** Acceptance ids explicitly waived by the user; manual items only. */
  waivers: string[]
  lastSeq: number
}
