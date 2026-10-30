import type { Context } from '@ruobai/cordis'
import { contractOf } from '@ruobai/contract'
import { deliveryOf, evaluate } from '@ruobai/delivery'
import type {} from '@ruobai/session'
import { HttpError, sendJson } from '@ruobai/web-server'

export const name = 'delivery-web'
// Both `contract` and `delivery` expose projections, not services, so this
// adapter reads them at request time instead of injecting them.
export const inject = ['web', 'sessions']

export interface DeliverySnapshot {
  sessionId: string
  rev: number
  contract: {
    id: string
    title: string
    customer: string | null
    goals: string[]
    nonGoals: string[]
    revision: number
    acceptance: Array<{ id: string; criterion: string; kind: 'auto' | 'manual' }>
  } | null
  verdict: 'pass' | 'fail' | 'unsure'
  reason: string | null
  checks: Array<{
    acceptanceId: string
    status: 'passed' | 'failed' | 'missing' | 'manual-pending'
    reason: string
    evidence: string[]
  }>
  waivers: string[]
  /** The delivery gate blocks the turn while this is true. */
  blocked: boolean
}

/**
 * Snapshot + push for the delivery panel.
 *
 * The verdict is recomputed on every read from the log, so the panel can never
 * show a stale "passed" for evidence that has since failed.
 */
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.web.register({
        prefix: '/api/delivery',
        handler: (req, res, url) => {
          if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'method not allowed')
          if (url.pathname.replace(/\/$/, '') !== '/api/delivery') throw new HttpError(404, 'not found')
          const sessionId = url.searchParams.get('sessionId')?.trim()
          if (!sessionId) throw new HttpError(400, 'sessionId is required')
          if (!ctx.sessions.get(sessionId)) throw new HttpError(404, `unknown session: ${sessionId}`)
          sendJson(res, 200, snapshot(ctx, sessionId))
          return true
        },
      }),
    'delivery-web.api',
  )
}

export default { name, inject, apply }

export function snapshot(ctx: Context, sessionId: string): DeliverySnapshot {
  const contract = contractOf(ctx, sessionId).open
  const state = deliveryOf(ctx, sessionId)
  const verdict = evaluate(ctx, sessionId)
  return {
    sessionId,
    rev: ctx.sessions.get(sessionId)?.events.length ?? 0,
    contract: contract
      ? {
        id: contract.id,
        title: contract.title,
        customer: contract.customer ?? null,
        goals: contract.goals,
        nonGoals: contract.nonGoals,
        revision: contract.revision,
        acceptance: contract.acceptance.map(item => ({
          id: item.id,
          criterion: item.criterion,
          kind: item.kind,
        })),
      }
    : null,
    verdict: verdict.verdict,
    reason: verdict.reason ?? null,
    checks: verdict.checks.map(check => ({
      acceptanceId: check.acceptanceId,
      status: check.status,
      reason: check.reason,
      evidence: check.evidence.map(ref => ref.summary),
    })),
    waivers: state.waivers,
    blocked: verdict.verdict === 'fail',
  }
}

export const meta = {
  title: '交付面板',
  description: '读取并推送契约、验收状态与交付裁决。',
}
