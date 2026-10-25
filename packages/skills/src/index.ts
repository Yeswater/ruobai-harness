import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type {} from '@ruobai/workspace'
import {
  discoverSkills, escapeXml, listResources, readResource, readSkillBody, skillRoots,
  type SkillRecord, type SkillSummary,
} from './discovery.ts'
import { createSkillTool } from './tool.ts'

export type { SkillRecord, SkillSummary, SkillSource } from './discovery.ts'
export { parseSkillDocument } from './frontmatter.ts'

export interface Config {
  /** User-global protocol directory; defaults to ~/.ruobai. */
  globalRoot?: string
  /** Home directory used for ~/.claude and ~/.agents compatibility roots. */
  homeDir?: string
  /** How long the discovered catalog is reused. */
  ttlMs?: number
  maxSkills?: number
  maxSkillBytes?: number
}

export interface RenderOptions {
  file?: string
}

declare module '@ruobai/cordis' {
  interface Context {
    skills: SkillsService
  }
}

/**
 * Discovers Agent Skills (SKILL.md bundles and flat markdown files) from the
 * workspace and the user's home, exposing a catalog plus on-demand loading.
 */
export class SkillsService extends Service {
  static inject = ['tools', 'workspace']

  static Config: z<Config> = z.object({
    globalRoot: z.string(),
    homeDir: z.string(),
    ttlMs: z.number().min(0).default(5_000),
    maxSkills: z.number().min(1).default(200),
    maxSkillBytes: z.number().min(1).default(262_144),
  })

  private readonly cache = new Map<string, { at: number; records: SkillRecord[] }>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'skills')
    ctx.effect(() => ctx.tools.register(createSkillTool(this)), 'skills.tool')
  }

  private workspaceRoot(sessionId?: string) {
    return this.ctx.workspace.rootFor(sessionId)
  }

  private globalRoot() {
    return this.config.globalRoot ?? join(homedir(), '.ruobai')
  }

  private maxBytes() {
    return this.config.maxSkillBytes ?? 262_144
  }

  private async records(sessionId?: string) {
    const root = this.workspaceRoot(sessionId)
    const cached = this.cache.get(root)
    const ttl = this.config.ttlMs ?? 5_000
    if (cached && Date.now() - cached.at < ttl) return cached.records
    const records = await discoverSkills(
      skillRoots(root, this.globalRoot(), this.config.homeDir ?? homedir()),
      {
        maxSkills: this.config.maxSkills,
        maxSkillBytes: this.config.maxSkillBytes,
      },
    )
    this.cache.set(root, { at: Date.now(), records })
    return records
  }

  async list(sessionId?: string): Promise<SkillSummary[]> {
    return (await this.records(sessionId)).map(({ bodyPath: _body, bundleDir: _dir, ...summary }) => summary)
  }

  /** Roots scanned for this workspace, in priority order. */
  roots(sessionId?: string) {
    return skillRoots(
      this.workspaceRoot(sessionId),
      this.globalRoot(),
      this.config.homeDir ?? homedir(),
    )
  }

  async get(name: string, sessionId?: string): Promise<SkillSummary | undefined> {
    return (await this.list(sessionId)).find(skill => skill.name === name)
  }

  /** `<available_skills>` block; empty when nothing is model-invocable. */
  async catalog(sessionId?: string): Promise<string> {
    const skills = (await this.records(sessionId)).filter(skill => skill.modelInvocable)
    if (!skills.length) return ''
    const lines = skills.map(skill => `- ${escapeXml(skill.name)}: ${escapeXml(skill.description)}`)
    return [
      '<available_skills>',
      ...lines,
      '</available_skills>',
      'Load a skill with the skill tool before following it. A user message containing /<name> means that skill should be loaded.',
    ].join('\n')
  }

  async render(name: string, sessionId?: string, options: RenderOptions = {}): Promise<string | undefined> {
    const record = (await this.records(sessionId)).find(skill => skill.name === name)
    if (!record) return undefined
    if (options.file) {
      const text = await readResource(record, options.file, this.maxBytes())
      if (text === undefined) return undefined
      return [
        `<skill_file name="${escapeXml(record.name)}" path="${escapeXml(options.file)}">`,
        text.trim(),
        '</skill_file>',
      ].join('\n')
    }
    const body = await readSkillBody(record, this.maxBytes())
    if (body === undefined) return undefined
    const resources = await listResources(record)
    const lines = [
      `<skill_content name="${escapeXml(record.name)}" source="${record.source}">`,
    ]
    if (resources.length) {
      lines.push('<skill_resources>', ...resources.map(file => `- ${escapeXml(file)}`), '</skill_resources>')
    }
    lines.push('<skill_instructions>', body, '</skill_instructions>', '</skill_content>')
    return lines.join('\n')
  }

  /** Drops a cached workspace (or everything) so the next call rescans. */
  invalidate(root?: string) {
    if (root) this.cache.delete(resolve(root))
    else this.cache.clear()
  }
}

export default SkillsService

export const meta = {
  title: '技能库',
  description: '发现 .ruobai/.claude/.agents 下的 SKILL.md，并按需加载正文。',
}
