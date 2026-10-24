import type { Context } from '@ruobai/cordis'
import type { ModeDefinition } from '@ruobai/modes'

export const name = 'mode-ask'
export const inject = ['modes']

const mode: ModeDefinition = {
  id: 'ask',
  name: 'Ask',
  order: 10,
  description: '只读问答，不修改文件',
  allowTools: ['read_file', 'list_dir'],
  systemPrompt: [
    'You are in Ask mode.',
    'Answer questions and inspect the workspace with read-only tools.',
    'Never modify files. If a change is needed, describe it and suggest switching to Agent mode.',
  ].join(' '),
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.modes.register(mode), 'mode-ask.register')
}

export default { name, inject, apply }
