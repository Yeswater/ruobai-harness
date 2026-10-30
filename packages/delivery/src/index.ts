import { Service, type Context } from '@ruobai/cordis'
import type {} from '@ruobai/context'
import { contractOf, type AcceptanceItem, type TaskContract } from '@ruobai/contract'
import type { SessionEvent } from '@ruobai/session'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'
import type {
  DeliveryCheck,
  DeliveryClaim,
  DeliveryClaimItem,
  DeliveryState,
  DeliveryVerdict,
  EvidenceRef,
} from './types.ts'

export type * from './types.ts'

export const name = 'delivery'

export const DELIVERY_CLAIM_EVENT = 'delivery/claim'
export const DELIVERY_VERDICT_EVENT = 'delivery/verdict'
export const DELIVERY_WAIVER_EVENT = 'delivery/waiver'
export const DELIVERY_PROJECTION = 'delivery'

const EMPTY: DeliveryState = { claims: [], waivers: [], lastSeq: -1 }
const MAX_CLAIMS = 20
const MAX_TEXT = 400

/**
 * Fold delivery events into "what has been claimed and what the user waived".
 *
 * A claim is a statement, not a proof: the verdict is recomputed from the log
 * every time, so the projection never becomes a second source of truth.
 */
export const deliveryProjection = {
  init: () => EMPTY,
  apply(state: DeliveryState, event: SessionEvent): DeliveryState {
    if (event.type === DELIVERY_CLAIM_EVENT) {
      const claim = event.data as DeliveryClaim | undefined
      if (!claim?.contractId) return state
      return { ...state, claims: [...state.claims, claim], lastSeq: event.seq }
    }
    if (event.type === DELIVERY_VERDICT_EVENT) {
      const verdict = event.data as DeliveryVerdict | undefined
      if (!verdict?.verdict) return state
      return { ...state, verdict, lastSeq: event.seq }
    }
    if (event.type === DELIVERY_WAIVER_EVENT) {
      const acceptanceId = (event.data as { acceptanceId?: string } | undefined)?.acceptanceId
      if (!acceptanceId) return state
      return state.waivers.includes(acceptanceId)
        ? state
        : { ...state, waivers: [...state.waivers, acceptanceId], lastSeq: event.seq }
    }
    return state
  },
}

export function deliveryOf(ctx: Context, sessionId: string): DeliveryState {
  const view = ctx.sessions.view<Record<string, unknown>>(sessionId)
  return (view?.[DELIVERY_PROJECTION] as DeliveryState | undefined) ?? EMPTY
}

declare module '@ruobai/cordis' {
  interface Context {
    delivery: DeliveryService
  }
}

/**
 * Delivery evidence service: claims, waivers and the recomputed verdict.
 *
 * `contract` is a peer plugin, not a service (it exposes a projection), so it
 * must not appear in `inject` — that would leave the fiber PENDING forever.
 * The verdict is always recomputed from the log, never cached.
 */
export class DeliveryService extends Service {
  static inject = ['tools', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 'delivery')

    ctx.effect(() => ctx.sessions.registerProjection(DELIVERY_PROJECTION, deliveryProjection), 'delivery.projection')
    ctx.effect(() => ctx.tools.register(claimTool(ctx)), 'delivery.claim')
    ctx.effect(() => ctx.tools.register(waiveTool(ctx)), 'delivery.waive')

    const section = {
      id: DELIVERY_PROJECTION,
      order: 86,
      stability: 'epoch' as const,
      maxChars: 4_000,
      render: ({ sessionId }: { sessionId: string }) => renderDelivery(deliveryOf(ctx, sessionId).verdict),
    }
    ctx.inject(['context'], (sectionCtx) => {
      sectionCtx.effect(() => sectionCtx.context.registerSection(section), 'delivery.section')
    })
  }

  /** Recompute the verdict; reading it never writes to the log. */
  evaluate(sessionId: string): DeliveryVerdict {
    return evaluate(this.ctx, sessionId)
  }
}

export default DeliveryService

/**
 * Recompute the verdict from the log.
 *
 * Pure with respect to session state: callers decide whether to persist it.
 * `unsure` is reserved for "cannot judge" (no contract), never for "looks
 * good"; a gate that cannot run must not read as a pass.
 */
export function evaluate(ctx: Context, sessionId: string): DeliveryVerdict {
  const contract: TaskContract | null = contractOf(ctx, sessionId).open
  const now = Date.now()
  if (!contract) {
    return { contractId: '', verdict: 'unsure', checks: [], at: now, reason: 'no-contract' }
  }

  const state = deliveryOf(ctx, sessionId)
  const results = toolResults(ctx, sessionId)
  const checks = contract.acceptance.map(item => judge(item, state, results))
  return {
    contractId: contract.id,
    verdict: checks.every(check => check.status === 'passed') ? 'pass' : 'fail',
    checks,
    at: now,
  }
}

function toolResults(ctx: Context, sessionId: string) {
  const map = new Map<number, { name: string; isError: boolean }>()
  for (const event of ctx.sessions.get(sessionId)?.events ?? []) {
    if (event.type !== 'tool/result') continue
    map.set(event.seq, {
      name: typeof event.data?.name === 'string' ? event.data.name : '',
      isError: event.data?.isError === true,
    })
  }
  return map
}

function judge(
  item: AcceptanceItem,
  state: DeliveryState,
  results: Map<number, { name: string; isError: boolean }>,
): DeliveryCheck {
  if (state.waivers.includes(item.id)) {
    return { acceptanceId: item.id, status: 'passed', reason: 'waived by the user', evidence: [] }
  }
  if (item.kind === 'manual') {
    return {
      acceptanceId: item.id,
      status: 'manual-pending',
      reason: 'needs a manual waiver from the user',
      evidence: [],
    }
  }

  const claim = latestClaim(state.claims, item.id)
  if (!claim?.evidence.length) {
    return { acceptanceId: item.id, status: 'missing', reason: 'no evidence claimed', evidence: [] }
  }

  const stale = claim.evidence.filter((ref) => {
    if (ref.kind !== 'tool' || typeof ref.seq !== 'number') return false
    const result = results.get(ref.seq)
    return !result || result.isError
  })
  if (stale.length) {
    return {
      acceptanceId: item.id,
      status: 'failed',
      reason: `evidence ${stale.map(ref => ref.ref).join(', ')} points at a failed or missing tool call`,
      evidence: claim.evidence,
    }
  }
  return {
    acceptanceId: item.id,
    status: 'passed',
    reason: 'evidence traces to a successful tool call',
    evidence: claim.evidence,
  }
}

function latestClaim(claims: DeliveryClaim[], acceptanceId: string): DeliveryClaimItem | undefined {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    const item = claims[index]!.items.find(candidate => candidate.acceptanceId === acceptanceId)
    if (item) return item
  }
  return undefined
}

function claimTool(ctx: Context): ToolDefinition {
  return {
    name: 'delivery_claim',
    description: [
      'Claim that one or more acceptance items are met, citing the tool calls that prove it.',
      'Evidence points at a tool/result seq; the verdict is recomputed from the log, so a made-up seq fails.',
      'Manual acceptance items cannot be claimed: they need delivery_waive from the user.',
    ].join(' '),
    // Session scratch state, not an external side effect.
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'One entry per acceptance item being claimed.',
          items: {
            type: 'object',
            properties: {
              acceptanceId: { type: 'string', description: 'e.g. "A1".' },
              claim: { type: 'string', description: 'What was verified, in one sentence.' },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['tool', 'manual'] },
                    ref: { type: 'string', description: 'The tool/result seq as a string.' },
                    seq: { type: 'number' },
                    summary: { type: 'string' },
                  },
                  required: ['kind', 'ref', 'summary'],
                },
              },
            },
            required: ['acceptanceId', 'claim', 'evidence'],
          },
        },
      },
      required: ['items'],
    },
    execute(args, run) {
      const sessionId = run?.sessionId
      if (!sessionId) throw new Error('delivery_claim requires a session')
      const contract = contractOf(ctx, sessionId).open
      if (!contract) throw new Error('no open contract; open one with contract_open first')

      const items = normalizeClaimItems(ctx, sessionId, contract, args?.items)
      const claim: DeliveryClaim = { contractId: contract.id, items, at: Date.now() }
      ctx.sessions.append(sessionId, DELIVERY_CLAIM_EVENT, claim)
      const verdict = evaluate(ctx, sessionId)
      return `Claim recorded for ${items.map(item => item.acceptanceId).join(', ')}. Current verdict: ${verdict.verdict} (${verdict.checks.filter(check => check.status === 'passed').length}/${verdict.checks.length} accepted).`
    },
  }
}

function waiveTool(ctx: Context): ToolDefinition {
  return {
    name: 'delivery_waive',
    description: [
      'Record the user\'s explicit waiver for a manual acceptance item (for example "the customer signed off verbally").',
      'Only manual items can be waived; automatic items need traceable evidence instead.',
      'Never call it on the user\'s behalf without asking: a waiver is the user\'s statement, not the model\'s.',
    ].join(' '),
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        acceptanceId: { type: 'string' },
        reason: { type: 'string', description: 'What the user said that justifies the waiver.' },
      },
      required: ['acceptanceId', 'reason'],
    },
    execute(args, run) {
      const sessionId = run?.sessionId
      if (!sessionId) throw new Error('delivery_waive requires a session')
      const contract = contractOf(ctx, sessionId).open
      if (!contract) throw new Error('no open contract')
      const id = typeof args?.acceptanceId === 'string' ? args.acceptanceId.trim() : ''
      const item = contract.acceptance.find(candidate => candidate.id === id)
      if (!item) throw new Error(`unknown acceptance ${id || '(empty)'}`)
      if (item.kind !== 'manual') throw new Error(`acceptance ${id} is automatic; it needs evidence, not a waiver`)
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      if (!reason) throw new Error('delivery_waive requires a reason')

      ctx.sessions.append(sessionId, DELIVERY_WAIVER_EVENT, { acceptanceId: id, reason, at: Date.now() })
      return `Acceptance ${id} waived.`
    },
  }
}

function normalizeClaimItems(
  ctx: Context,
  sessionId: string,
  contract: TaskContract,
  input: unknown,
): DeliveryClaimItem[] {
  if (!Array.isArray(input) || !input.length) throw new Error('items must be a non-empty array')
  if (input.length > MAX_CLAIMS) throw new Error(`items is limited to ${MAX_CLAIMS} entries`)

  const known = new Map(contract.acceptance.map(item => [item.id, item]))
  const results = toolResults(ctx, sessionId)
  const seen = new Set<string>()

  return input.map((raw, index) => {
    const item = (raw ?? {}) as { acceptanceId?: unknown; claim?: unknown; evidence?: unknown }
    const acceptanceId = typeof item.acceptanceId === 'string' ? item.acceptanceId.trim() : ''
    const acceptance = known.get(acceptanceId)
    if (!acceptance) throw new Error(`unknown acceptance ${acceptanceId || `#${index + 1}`}`)
    if (acceptance.kind !== 'auto') {
      throw new Error(`acceptance ${acceptanceId} is manual; use delivery_waive instead of delivery_claim`)
    }
    if (seen.has(acceptanceId)) throw new Error(`duplicate acceptance ${acceptanceId}`)
    seen.add(acceptanceId)

    const claim = typeof item.claim === 'string' ? item.claim.trim() : ''
    if (!claim) throw new Error(`acceptance ${acceptanceId} has no claim text`)
    if (claim.length > MAX_TEXT) throw new Error(`acceptance ${acceptanceId} claim is too long`)

    if (!Array.isArray(item.evidence) || !item.evidence.length) {
      throw new Error(`acceptance ${acceptanceId} has no evidence`)
    }

    const evidence: EvidenceRef[] = item.evidence.map((rawRef, refIndex) => {
      const ref = (rawRef ?? {}) as { kind?: unknown; ref?: unknown; seq?: unknown; summary?: unknown }
      const summary = typeof ref.summary === 'string' ? ref.summary.trim() : ''
      if (!summary) throw new Error(`acceptance ${acceptanceId} evidence ${refIndex + 1} has no summary`)
      if (ref.kind === 'manual') {
        return { kind: 'manual', ref: typeof ref.ref === 'string' ? ref.ref : 'manual', summary }
      }
      const seq = typeof ref.seq === 'number' ? ref.seq : Number(ref.ref)
      if (!Number.isInteger(seq)) throw new Error(`acceptance ${acceptanceId} evidence ${refIndex + 1} needs a seq`)
      if (!results.has(seq)) {
        throw new Error(`acceptance ${acceptanceId} evidence ${seq} is not a tool result in this session`)
      }
      return { kind: 'tool', ref: String(seq), seq, summary }
    })

    return { acceptanceId, claim, evidence }
  })
}

function renderDelivery(verdict: DeliveryVerdict | undefined): string {
  if (!verdict) return ''
  const failed = verdict.checks.filter(check => check.status !== 'passed')
  return [
    `<delivery verdict="${verdict.verdict}"${verdict.reason ? ` reason="${verdict.reason}"` : ''}>`,
    `Accepted: ${verdict.checks.length - failed.length}/${verdict.checks.length}`,
    ...failed.map(check => `- ${check.acceptanceId} [${check.status}] ${check.reason}`),
    verdict.verdict === 'pass' ? 'Every acceptance item is covered.' : 'Do not claim delivery until these are covered.',
    '</delivery>',
  ].join('\n')
}
