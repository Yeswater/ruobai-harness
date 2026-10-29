import type { Context } from '@ruobai/cordis'
import type { ModeDefinition } from '@ruobai/modes'

export const name = 'mode-plan'
export const inject = ['modes']

const mode: ModeDefinition = {
  id: 'plan',
  name: 'Plan',
  order: 20,
  description: '只读分析并产出实施计划',
  allowTools: ['read_file', 'list_dir', 'grep', 'glob', 'gitee_repo', 'gitee_issue', 'gitee_pr', 'plan_submit'],
  systemPrompt: [
    'You are in Plan mode.',
    'Inspect the codebase as needed, then produce a concrete implementation plan.',
    'Structure the plan as: goal, ordered steps, files to change, risks, and verification.',
    // The card, not prose, is what the user can act on: it carries the accept
    // and revise buttons, and accepting starts the execution turn.
    'Do not modify files. Finish by calling plan_submit with the plan; do not paste the plan as chat text only.',
    'The user can accept it (then execute it) or ask for changes.',
  ].join(' '),
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.modes.register(mode), 'mode-plan.register')
}

export default { name, inject, apply }

export const meta = {
  title: 'Plan 模式',
  description: '先制定计划，再决定是否执行。',
}
