import type { ToolDefinition } from '@ruobai/tools'
import type { A2aCard } from './card.ts'
import { sendAgentMessage } from './client.ts'
import type { A2aAgentConfig } from './config.ts'

export function a2aToolName(id: string) {
  return `a2a__${id}`
}

/** One stable tool per remote agent; skills are described, not multiplied. */
export function createA2aTool(config: A2aAgentConfig, card: A2aCard): ToolDefinition {
  const skills = card.skills.length
    ? ` Skills: ${card.skills
      .map(skill => `${skill.name}${skill.description ? ` (${skill.description})` : ''}`)
      .join('; ')}.`
    : ''
  return {
    name: a2aToolName(config.id),
    description: [
      `Remote A2A agent "${card.name}"`,
      card.description ? `: ${card.description}` : '.',
      skills,
      'Send a self-contained prompt; the remote agent executes it and returns its reply.',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Complete instructions for the remote agent.' },
        skill: { type: 'string', description: 'Optional skill id advertised by the agent card.' },
        contextId: { type: 'string', description: 'Optional A2A context id to continue a conversation.' },
      },
      required: ['message'],
    },
    readOnly: config.readOnly === true,
    requiresApproval: config.approval === 'never'
      ? false
      : config.readOnly === true && config.approval !== 'always'
        ? false
        : true,
    preview: args => ({
      summary: `A2A · ${card.name}`,
      diff: String(args?.message ?? ''),
    }),
    async execute(args, run) {
      const message = String(args?.message ?? '').trim()
      if (!message) throw new Error('message is required')
      return sendAgentMessage(card, message, {
        headers: config.headers,
        timeoutMs: config.timeoutMs,
        signal: run?.signal,
        allowPrivateHosts: config.allowPrivateHosts,
        skill: typeof args?.skill === 'string' && args.skill.trim() ? args.skill.trim() : undefined,
        contextId: typeof args?.contextId === 'string' && args.contextId.trim()
          ? args.contextId.trim()
          : undefined,
      })
    },
  }
}
