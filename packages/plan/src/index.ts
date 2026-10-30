import { randomUUID } from 'node:crypto'
import type { Context } from '@ruobai/cordis'
import type { SessionEvent } from '@ruobai/session'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'

export const name = 'plan'
export const inject = ['tools', 'sessions']

/** A plan waiting for the user's decision. */
export interface PlanProposal {
  id: string
  sessionId: string
  /** Short noun phrase shown as the card's heading. */
  title: string
  /** Markdown body: goal, ordered steps, files, risks, verification. */
  plan: string
  createdAt: number
}

export type PlanAction = 'accept' | 'revise'

export interface PlanResolution {
  id: string
  sessionId: string
  action: PlanAction
  /** What to change, for `revise`. */
  feedback?: string
  at: number
}

export interface PlanState {
  proposal: PlanProposal | null
  lastSeq: number
}

export const PLAN_EVENT = 'plan/proposed'
export const PLAN_RESOLVED_EVENT = 'plan/resolved'
export const PLAN_PROJECTION = 'plan'

declare module '@ruobai/cordis' {
  interface Events {
    'plan/requested'(proposal: PlanProposal): void
    'plan/resolved'(resolution: PlanResolution): void
  }
}

const EMPTY: PlanState = { proposal: null, lastSeq: -1 }
const MAX_TITLE = 80
const MAX_PLAN = 20_000

/**
 * Fold the plan events into "the plan the user has not answered yet".
 *
 * The proposal is durable state, not an in-memory request: a reloaded or
 * reopened session must still show the card. The resolution removes it, so a
 * finished plan is read from the transcript, not from the card.
 */
export const planProjection = {
  init: () => EMPTY,
  apply(state: PlanState, event: SessionEvent): PlanState {
    if (event.type === PLAN_EVENT) {
      const data = event.data as PlanProposal | undefined
      if (!data?.id) return state
      return { proposal: data, lastSeq: event.seq }
    }
    if (event.type === PLAN_RESOLVED_EVENT) {
      const id = (event.data as { id?: string } | undefined)?.id
      if (!id || state.proposal?.id !== id) return state
      return { proposal: null, lastSeq: event.seq }
    }
    return state
  },
}

export function planOf(ctx: Context, sessionId: string): PlanState {
  const view = ctx.sessions.view<Record<string, unknown>>(sessionId)
  return (view?.[PLAN_PROJECTION] as PlanState | undefined) ?? EMPTY
}

/** Record the decision and return it; unknown or stale ids change nothing. */
export function resolvePlan(
  ctx: Context,
  sessionId: string,
  id: string,
  input: { action: PlanAction; feedback?: string },
): PlanResolution | undefined {
  if (planOf(ctx, sessionId).proposal?.id !== id) return undefined
  const feedback = input.feedback?.trim()
  const resolution: PlanResolution = {
    id,
    sessionId,
    action: input.action,
    ...(feedback ? { feedback } : {}),
    at: Date.now(),
  }
  ctx.sessions.append(sessionId, PLAN_RESOLVED_EVENT, resolution)
  ctx.emit('plan/resolved', resolution)
  return resolution
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.sessions.registerProjection(PLAN_PROJECTION, planProjection), 'plan.projection')
  ctx.effect(() => ctx.tools.register(planTool(ctx)), 'plan.tool')
}

export default { name, inject, apply }

function planTool(ctx: Context): ToolDefinition {
  return {
    name: 'plan_submit',
    defer: true,
    keywords: ['plan', '计划', '方案', '实施'],
    // Session scratch state: it records a proposal, it does not touch the world.
    readOnly: true,
    description: [
      'Present an implementation plan and let the user approve or revise it.',
      'Use it after inspecting the codebase and before writing any files, especially in Plan mode.',
      'Put the whole plan in `plan` as Markdown: goal, ordered steps, files to change, risks, verification.',
      'Do not write the plan only as chat text, and do not start implementing before the user accepts it.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading, e.g. "登录页拆分与路由改造".' },
        plan: { type: 'string', description: 'The plan as Markdown.' },
      },
      required: ['plan'],
    },
    execute(args, run) {
      const sessionId = run?.sessionId
      if (!sessionId) throw new Error('plan_submit requires a session')
      const plan = typeof args?.plan === 'string' ? args.plan.trim() : ''
      if (!plan) throw new Error('plan_submit requires a non-empty plan')
      if (plan.length > MAX_PLAN) throw new Error(`the plan is longer than ${MAX_PLAN} characters`)
      const rawTitle = typeof args?.title === 'string' ? args.title.trim() : ''
      const proposal: PlanProposal = {
        id: randomUUID(),
        sessionId,
        title: (rawTitle || firstHeading(plan) || '实施计划').slice(0, MAX_TITLE),
        plan,
        createdAt: Date.now(),
      }
      ctx.sessions.append(sessionId, PLAN_EVENT, proposal)
      ctx.emit('plan/requested', proposal)
      return '计划已提交给用户，正在等待确认。现在停止继续输出：用户接受后会发来执行指令，提出修改时会给出反馈。'
    },
  }
}

function firstHeading(plan: string) {
  const line = plan.split('\n').find(item => /^#{1,3}\s+\S/.test(item.trim()))
  return line?.replace(/^#{1,3}\s+/, '').trim()
}
