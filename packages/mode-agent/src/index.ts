import type { Context } from '@ruobai/cordis'
import type { ModeDefinition } from '@ruobai/modes'

export const name = 'mode-agent'
export const inject = ['modes']

const mode: ModeDefinition = {
  id: 'agent',
  name: 'Agent',
  order: 30,
  description: '执行任务，可读写文件（写操作需审批）',
  systemPrompt: [
    'You are in Agent mode.',
    'Execute the task end-to-end: inspect the workspace, make the necessary changes with tools, and verify the result.',
    'Mutating tools require user approval; wait for it and continue from the tool result.',
  ].join(' '),
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.modes.register(mode), 'mode-agent.register')
}

export default { name, inject, apply }

export const meta = {
  title: 'Agent 模式',
  description: '直接使用工具完成任务。',
}
