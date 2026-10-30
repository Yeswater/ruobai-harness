import type { Context } from '@ruobai/cordis'
import { contractOf } from '@ruobai/contract'
import { evaluate } from '@ruobai/delivery'
import z from '@ruobai/schemastery'
import { visibleTo, type SessionEvent } from '@ruobai/session'
import type {} from '@ruobai/session'

export interface Config {
  /** Off by default: an audit surface exposed by accident is a leak. */
  enabled?: boolean
}

export const name = 'client-audit'
export const inject = ['web', 'sessions']

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/**
 * Read-only view of a delivery for the customer.
 *
 * Three rules hold by construction rather than by handler discipline:
 * 1. the plugin is off unless `enabled: true`, so it never widens the default
 *    surface;
 * 2. every route is GET-only and served from projections, never from a write
 *    service — the plugin does not inject `git`, `settings`, `secrets`;
 * 3. events leave only if `visibility === 'client'`, and only as a summary,
 *    never as their raw payload.
 */
export function apply(ctx: Context, config: Config) {
  if (config.enabled !== true) return

  ctx.effect(() => ctx.web.register({
    prefix: '/api/audit',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'client-audit.route')
}

export default { name, inject, Config, apply }

async function handle(ctx: Context, req: any, res: any, url: URL) {
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'read-only view' })

  const match = /^\/api\/audit\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname)
  if (!match) return send(res, 404, { error: 'not found' })

  const sessionId = decodeURIComponent(match[1]!)
  if (!ctx.sessions.get(sessionId)) return send(res, 404, { error: 'unknown session' })

  switch (match[2] ?? 'summary') {
    case 'summary':
      return send(res, 200, summary(ctx, sessionId))
    case 'timeline':
      return send(res, 200, timeline(ctx, sessionId))
    case 'acceptance':
      return send(res, 200, acceptance(ctx, sessionId))
    case 'changes':
      return send(res, 200, changes(ctx, sessionId))
    default:
      return send(res, 404, { error: 'unknown view' })
  }
}

function summary(ctx: Context, sessionId: string) {
  const meta = ctx.sessions.get(sessionId)!.meta
  const verdict = evaluate(ctx, sessionId)
  return {
    session: {
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    },
    verdict: {
      status: verdict.verdict,
      accepted: verdict.checks.filter(check => check.status === 'passed').length,
      total: verdict.checks.length,
      at: verdict.at,
    },
  }
}

function timeline(ctx: Context, sessionId: string) {
  const events = ctx.sessions.get(sessionId)?.events ?? []
  return {
    sessionId,
    // Only client-visible events, and only a summary: raw payloads may contain
    // internal paths, commands or secrets that never belong in an audit view.
    entries: events
      .filter(event => visibleTo(event, 'client'))
      .map(event => ({
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        summary: summarize(event),
      })),
  }
}

function acceptance(ctx: Context, sessionId: string) {
  const contract = contractOf(ctx, sessionId).open
  const verdict = evaluate(ctx, sessionId)
  return {
    contract: contract
      ? {
        id: contract.id,
        title: contract.title,
        customer: contract.customer,
        goals: contract.goals,
        nonGoals: contract.nonGoals,
        acceptance: contract.acceptance.map(item => ({ id: item.id, criterion: item.criterion, kind: item.kind })),
      }
      : null,
    checks: verdict.checks.map(check => ({
      acceptanceId: check.acceptanceId,
      status: check.status,
      reason: check.reason,
    })),
    verdict: verdict.verdict,
  }
}

function changes(ctx: Context, sessionId: string) {
  const view = ctx.sessions.view<{ checkpoints?: Array<{ path: string; tool: string; afterBytes?: number; at: number }> }>(sessionId)
  const latest = new Map<string, { path: string; tool: string; afterBytes?: number; at: number }>()
  for (const change of view?.checkpoints ?? []) latest.set(change.path, change)
  return {
    sessionId,
    files: [...latest.values()].map(change => ({
      path: change.path,
      tool: change.tool,
      bytes: change.afterBytes ?? null,
      at: change.at,
    })),
  }
}

function summarize(event: SessionEvent) {
  if (event.type === 'message/user' || event.type === 'message/assistant') {
    const text = typeof event.data?.text === 'string' ? event.data.text : ''
    return text.slice(0, 200)
  }
  return event.type
}

function send(res: any, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
