import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type {} from '@ruobai/memory'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'
import type {} from '@ruobai/wiki'
import type {} from '@ruobai/workspace'

export interface Config {
  memoryLimit?: number
  wikiLimit?: number
  skillLimit?: number
  maxChars?: number
}

export type SearchType = 'memory' | 'wiki' | 'skill'

export interface TypedQuery {
  type: SearchType
  priority: number
}

/**
 * Rule-based intent split. Zero-cost and deterministic; a query that matches
 * nothing searches all three rather than guessing. It never calls a model.
 */
export function planQueries(query: string): TypedQuery[] {
  const text = query.toLowerCase()
  const types: SearchType[] = []
  if (/记忆|偏好|约束|决策|之前(?:说|定|提)|remember|memory|preference/.test(text)) types.push('memory')
  if (/知识库|wiki|页面|文档|方案|架构|设计|sop|sandbox|seatbelt/.test(text)) types.push('wiki')
  if (/技能|skill|流程|步骤|playbook|sop/.test(text)) types.push('skill')
  const chosen = types.length ? [...new Set(types)] : ['memory', 'wiki', 'skill'] as SearchType[]
  return chosen.map((type, priority) => ({ type, priority }))
}

/** Unified retrieval across memory, wiki and skills with per-type quotas. */
export function apply(ctx: Context, config: Config = {}) {
  ctx.effect(() => ctx.tools.register(contextSearchTool(ctx, config)), 'context-search.tool')
  ctx.effect(() => ctx.tools.register(skillProposeTool(ctx)), 'context-search.skill-propose')
}

function contextSearchTool(ctx: Context, config: Config): ToolDefinition {
  const memoryLimit = config.memoryLimit ?? 6
  const wikiLimit = config.wikiLimit ?? 6
  const skillLimit = config.skillLimit ?? 4
  const maxChars = config.maxChars ?? 8_000

  return {
    name: 'context_search',
    description: 'Search long-term memory, the project wiki and skills in one call. Each type has its own quota.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['memory', 'wiki', 'skill'] },
          description: 'Restrict the search; default uses rule-based intent.',
        },
      },
      required: ['query'],
    },
    readOnly: true,
    async execute(args, run) {
      const query = String(args?.query ?? '').trim()
      if (!query) return 'Empty query.'
      const requested = Array.isArray(args?.types)
        ? (args.types as unknown[]).filter((type): type is SearchType =>
          type === 'memory' || type === 'wiki' || type === 'skill')
        : []
      const plan = requested.length
        ? requested.map((type, priority) => ({ type, priority }))
        : planQueries(query)

      const lines: string[] = []
      let chars = 0
      for (const { type } of plan.sort((left, right) => left.priority - right.priority)) {
        if (chars >= maxChars) break
        if (type === 'memory') {
          const result = await ctx.memory.search(query, { limit: memoryLimit }, run?.sessionId)
          for (const item of result.items) {
            const line = `[memory] ${item.id} (${item.scope}${item.validTo ? ', dormant' : ''}) ${item.kind}: ${item.text}`
            if (chars + line.length > maxChars) break
            lines.push(line)
            chars += line.length + 1
          }
        } else if (type === 'wiki') {
          const result = await ctx.wiki.search(query, { limit: wikiLimit }, run?.sessionId)
          for (const hit of result.hits) {
            const line = `[wiki] ${hit.page} > ${hit.heading} (${hit.score}): ${hit.summary}`
            if (chars + line.length > maxChars) break
            lines.push(line)
            chars += line.length + 1
          }
        } else {
          const skills = ctx.get('skills', false) as
            | { list(sessionId?: string): Promise<Array<{ name: string; description?: string }>> }
            | undefined
          if (!skills) continue
          const term = query.toLowerCase()
          const matches = (await skills.list(run?.sessionId))
            .filter(skill => skill.name.toLowerCase().includes(term)
              || (skill.description ?? '').toLowerCase().includes(term))
            .slice(0, skillLimit)
          for (const skill of matches) {
            const line = `[skill] ${skill.name}: ${skill.description ?? ''}`
            if (chars + line.length > maxChars) break
            lines.push(line)
            chars += line.length + 1
          }
        }
      }

      if (!lines.length) return 'No matches.'
      return lines.join('\n')
    },
  }
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function skillProposeTool(ctx: Context): ToolDefinition {
  return {
    name: 'skill_propose',
    description: 'Draft a SKILL.md from a recurring procedure or memory. Writes a proposal only; a person must accept it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase slug, e.g. release-check.' },
        description: { type: 'string', description: 'One line: when to use this skill.' },
        body: { type: 'string', description: 'Markdown instructions. Steps and a validation section are recommended.' },
        memoryId: { type: 'string', description: 'Base the draft on this memory item.' },
      },
      required: ['name'],
    },
    async execute(args, run) {
      const name = String(args?.name ?? '').trim().toLowerCase()
      if (!SKILL_NAME.test(name)) throw new Error(`invalid skill name: ${name}`)
      const memoryId = args?.memoryId ? String(args.memoryId) : undefined
      const memory = memoryId
        ? (await ctx.memory.items(run?.sessionId)).get(memoryId)
        : undefined
      if (memoryId && !memory) throw new Error(`no such memory: ${memoryId}`)
      const description = String(args?.description ?? memory?.text ?? name).trim().slice(0, 240)
      const body = String(args?.body ?? draftBody(name, memory?.text)).trim()
      const root = join(ctx.workspace.rootFor(run?.sessionId), '.ruobai', 'skill-proposals', name)
      await mkdir(root, { recursive: true })
      const path = join(root, 'SKILL.md')
      await writeFile(path, [
        '---',
        `name: ${name}`,
        `description: ${JSON.stringify(description)}`,
        '---',
        '',
        body,
        '',
      ].join('\n'), 'utf8')
      return `Proposed ${path}`
    },
  }
}

function draftBody(name: string, basis?: string) {
  const lines = [`# ${name}`, '']
  if (basis) lines.push(`Based on memory: ${basis}`, '')
  lines.push('## 步骤', '', '1. ', '', '## 校验', '', '- ')
  return lines.join('\n')
}

const plugin = {
  name: 'context-search',
  inject: ['tools', 'memory', 'wiki', 'sessions', 'workspace'],
  Config: z.object({
    memoryLimit: z.number().min(1).default(6),
    wikiLimit: z.number().min(1).default(6),
    skillLimit: z.number().min(1).default(4),
    maxChars: z.number().min(100).default(8_000),
  }),
  apply,
}

export default plugin

export const meta = {
  title: '统一检索',
  description: '一次检索记忆、知识库与技能，按类型配额返回。',
}
