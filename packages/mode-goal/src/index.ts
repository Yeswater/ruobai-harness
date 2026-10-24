import type { Context } from '@ruobai/cordis'
import type { ModeDefinition } from '@ruobai/modes'

export const name = 'mode-goal'
export const inject = ['modes', 'tools']

/** The model calls this to end an autonomous goal turn. */
export const GOAL_COMPLETE = 'goal_complete'

const mode: ModeDefinition = {
  id: 'goal',
  name: 'Goal',
  order: 40,
  description: '多轮自主推进，完成后调用 goal_complete',
  autonomous: true,
  maxSteps: 32,
  extraTools: [GOAL_COMPLETE],
  systemPrompt: [
    'You are in Goal mode.',
    'Work autonomously toward the objective across rounds: plan, act with tools, verify, and keep going until it is complete or genuinely blocked.',
    'When the objective is achieved, call goal_complete with a short summary.',
    'Mutating tools require user approval; wait for it and continue from the tool result.',
  ].join(' '),
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.modes.register(mode), 'mode-goal.register')
  ctx.effect(() => ctx.tools.register({
    name: GOAL_COMPLETE,
    description: 'Mark the current goal as complete and stop the autonomous turn.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Short summary of what was achieved.' } },
      required: ['summary'],
    },
    execute(args) {
      return `Goal complete: ${String(args?.summary ?? '')}`
    },
  }), 'mode-goal.tool')
}

export default { name, inject, apply }
