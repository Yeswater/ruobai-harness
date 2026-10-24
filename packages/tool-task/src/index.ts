import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/agent'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'

export const name = 'tool-task'
export const inject = ['tools', 'sessions', 'agents']

const TIMEOUT_MS = 10 * 60_000

export function apply(ctx: Context) {
  ctx.effect(() => ctx.tools.register(taskTool(ctx)), 'tool-task.register')
}

export default { name, inject, apply }

function taskTool(ctx: Context): ToolDefinition {
  return {
    name: 'task',
    description: [
      'Delegate a focused, self-contained piece of work to a sub-agent and return its final answer.',
      'The sub-agent has the same workspace tools but cannot spawn another sub-agent.',
      'Use it for independent research or a self-contained implementation task when the extra context would otherwise clutter this conversation.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short label for the sub-task; shown in the session list.' },
        prompt: { type: 'string', description: 'Complete instructions for the sub-agent. It cannot see this conversation.' },
        maxSteps: { type: 'number', description: 'Step budget, default 16, capped at 32.' },
      },
      required: ['prompt'],
    },
    async execute(args, run) {
      const parentId = run?.sessionId
      if (!parentId) throw new Error('task requires a session')
      const parent = ctx.sessions.get(parentId)
      if (!parent) throw new Error(`unknown session: ${parentId}`)
      if (parent.meta.kind === 'subagent') throw new Error('sub-agents cannot spawn sub-agents')

      const prompt = String(args?.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt is required')
      const description = String(args?.description ?? '').trim()
      const maxSteps = Math.min(Math.max(Math.floor(Number(args?.maxSteps) || 16), 1), 32)

      const child = ctx.sessions.create({
        title: `子任务：${description || prompt.slice(0, 48)}`,
        mode: 'agent',
        model: parent.meta.model,
        provider: parent.meta.provider,
        workspace: parent.meta.workspace,
        kind: 'subagent',
        parentId,
      })

      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const signal = run.signal ? AbortSignal.any([run.signal, timeout]) : timeout

      try {
        const result = await ctx.agents.runToCompletion(child.id, prompt, {
          signal,
          maxSteps,
          denyTools: ['task'],
        })

        const text = result.text.trim()
        const shown = text.length > 20_000
          ? `${text.slice(0, 20_000)}\n\n… truncated (${text.length} characters)`
          : text || '(sub-agent produced no text)'
        return `Sub-agent finished (${result.reason}):\n\n${shown}`
      } finally {
        // Make the child's file writes visible (and revertible) in the parent.
        for (const event of ctx.sessions.get(child.id)?.events ?? []) {
          if (event.type === 'file/change') {
            ctx.sessions.append(parentId, 'file/change', event.data)
          }
        }
      }
    },
  }
}

export const meta = {
  title: '子任务工具',
  description: '把任务委派给独立的子代理。',
}
