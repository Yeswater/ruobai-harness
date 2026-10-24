import type { Context } from '@ruobai/cordis'
import type { ModeDefinition } from '@ruobai/modes'

export const name = 'mode-plan'
export const inject = ['modes']

const mode: ModeDefinition = {
  id: 'plan',
  name: 'Plan',
  order: 20,
  description: '只读分析并产出实施计划',
  allowTools: ['read_file', 'list_dir', 'grep', 'glob'],
  systemPrompt: [
    'You are in Plan mode.',
    'Inspect the codebase as needed, then produce a concrete implementation plan.',
    'Structure the plan as: goal, ordered steps, files to change, risks, and verification.',
    'Do not modify files. End with the plan; the user can switch to Agent mode to execute it.',
  ].join(' '),
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.modes.register(mode), 'mode-plan.register')
}

export default { name, inject, apply }
