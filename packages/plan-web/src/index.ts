import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/agent'
import type {} from '@ruobai/chat'
import type {} from '@ruobai/modes'
import type {} from '@ruobai/session'
import { planOf, resolvePlan, type PlanResolution } from '@ruobai/plan'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'plan-web'
export const inject = ['web', 'sessions', 'agents', 'chat', 'modes']

/**
 * Plan card surface: the pending proposal for reconnect, the accept/revise
 * endpoint, and the live push the card listens to.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/plans',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'plan-web.routes')

  ctx.effect(() => {
    const broadcast = (data: unknown) => {
      const ui = ctx.get('ui', false) as { broadcast?(channel: string, data: unknown): void } | undefined
      ui?.broadcast?.('plan', data)
    }
    const offRequested = ctx.on('plan/requested', proposal => broadcast({ kind: 'requested', proposal }))
    const offResolved = ctx.on('plan/resolved', (resolution) => {
      broadcast({
        kind: 'resolved',
        resolution: { id: resolution.id, sessionId: resolution.sessionId, action: resolution.action },
      })
    })
    return () => {
      offRequested()
      offResolved()
    }
  }, 'plan-web.push')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method ?? 'GET'

  if (url.pathname.replace(/\/$/, '') === '/api/plans') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed')
    const sessionId = url.searchParams.get('sessionId')?.trim()
    if (!sessionId) throw new HttpError(400, 'sessionId is required')
    if (!ctx.sessions.has(sessionId)) throw new HttpError(404, `unknown session: ${sessionId}`)
    sendJson(res, 200, { plan: planOf(ctx, sessionId).proposal })
    return true
  }

  const match = /^\/api\/plans\/([^/]+)$/.exec(url.pathname)
  if (match) {
    if (method !== 'POST') throw new HttpError(405, 'method not allowed')
    const body = await readJson(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!sessionId) throw new HttpError(400, 'sessionId is required')
    const action = body?.action
    if (action !== 'accept' && action !== 'revise') throw new HttpError(400, 'action must be accept or revise')
    const resolution = resolvePlan(ctx, sessionId, decodeURIComponent(match[1]!), {
      action,
      ...(typeof body?.feedback === 'string' ? { feedback: body.feedback } : {}),
    })
    if (!resolution) throw new HttpError(404, 'plan is no longer waiting for a decision')
    continueAfter(ctx, resolution)
    sendJson(res, 200, { ok: true, action: resolution.action })
    return true
  }

  throw new HttpError(404, 'not found')
}

/**
 * Hand the decision back to the model as a user message.
 *
 * Plan mode only offers read tools, so accepting a plan also switches the
 * session to a writable mode; otherwise the promised execution could not
 * touch a file. The turn that submitted the plan is stopped first: a message
 * queued into it would be read at the next step boundary, still under Plan
 * mode's toolset.
 */
function continueAfter(ctx: Context, resolution: PlanResolution) {
  const { sessionId, action } = resolution
  if (ctx.agents.isRunning(sessionId)) ctx.agents.stop(sessionId)

  if (action === 'accept') {
    if (ctx.sessions.get(sessionId)?.meta.mode === 'plan' && ctx.modes.get('agent')) {
      ctx.chat.setMode(sessionId, 'agent')
    }
    ctx.chat.send(sessionId, '计划已确认，按上面的计划开始执行。')
    return
  }

  const feedback = resolution.feedback?.trim()
  ctx.chat.send(sessionId, feedback ? `请按这个反馈修改计划：${feedback}` : '请修改计划，然后重新提交。')
}

export default { name, inject, apply }

export const meta = {
  title: '计划审批通道',
  description: '把待确认的实施计划推给界面，接收开始执行或修改意见。',
}
