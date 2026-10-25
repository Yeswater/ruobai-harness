import type { ToolDefinition } from '@ruobai/tools'

export interface SkillRenderer {
  render(
    name: string,
    sessionId?: string,
    options?: { file?: string },
  ): Promise<string | undefined>
}

/**
 * Progressive disclosure: the catalog only carries names and descriptions, so
 * this tool is the single way the model pulls in a full skill body.
 */
export function createSkillTool(skills: SkillRenderer): ToolDefinition {
  return {
    name: 'skill',
    description: [
      'Load a skill from the workspace or user skill directories.',
      'Call it with the skill name before following that skill; pass "file" to read one resource listed by the skill.',
      'A user message containing /<name> also asks for that skill.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from <available_skills>.' },
        file: { type: 'string', description: 'Optional bundled resource path to read instead of the body.' },
      },
      required: ['name'],
    },
    readOnly: true,
    async execute(args, run) {
      const name = String(args?.name ?? '').trim().toLowerCase()
      if (!name) throw new Error('name is required')
      const file = typeof args?.file === 'string' && args.file.trim() ? args.file.trim() : undefined
      const text = await skills.render(name, run?.sessionId, file ? { file } : undefined)
      if (text === undefined) {
        throw new Error(file ? `unknown skill resource: ${name}/${file}` : `unknown skill: ${name}`)
      }
      return text
    },
  }
}
