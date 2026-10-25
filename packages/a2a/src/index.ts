import { unwatchFile, watchFile } from 'node:fs'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import { fetchAgentCard } from './card.ts'
import {
  a2aConfigFiles, defaultGlobalRoot, mergeA2aConfigs, readA2aConfig, type A2aAgentConfig,
} from './config.ts'
import { a2aToolName, createA2aTool } from './tools.ts'

export type { A2aAgentConfig } from './config.ts'
export type { A2aCard, A2aSkill } from './card.ts'

export interface Config {
  /** Workspace whose `.ruobai/a2a.json` is read. */
  workspaceRoot?: string
  /** User-global directory; defaults to ~/.ruobai. */
  globalRoot?: string
  watchIntervalMs?: number
  cardTimeoutMs?: number
}

export interface A2aAgentInfo {
  id: string
  name: string
  url: string
  tool: string
  status: 'ok' | 'error' | 'disabled'
  error?: string
  skills: Array<{ id: string; name: string; description?: string }>
}

declare module '@ruobai/cordis' {
  interface Context {
    a2a: A2aService
  }
}

/**
 * Consumes remote A2A agents: loads `.ruobai/a2a.json`, fetches each Agent
 * Card, and registers one tool per agent. Reloads when the config changes.
 */
export class A2aService extends Service {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    workspaceRoot: z.string(),
    globalRoot: z.string(),
    watchIntervalMs: z.number().min(0).default(1_000),
    cardTimeoutMs: z.number().min(1_000).default(15_000),
  })

  private disposers: Array<() => void> = []
  private controllers = new Set<AbortController>()
  private agents: A2aAgentInfo[] = []
  private files: string[] = []
  private generation = 0

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'a2a')
    const interval = this.config.watchIntervalMs ?? 1_000
    if (interval > 0) {
      ctx.effect(() => {
        const files = this.configFiles()
        for (const file of files) {
          watchFile(file, { interval, persistent: false }, () => { void this.reload() })
        }
        return () => {
          for (const file of files) unwatchFile(file)
        }
      }, 'a2a.watch')
    }
    ctx.effect(() => () => {
      this.generation += 1
      for (const dispose of this.disposers) dispose()
      this.disposers = []
      for (const controller of this.controllers) controller.abort()
      this.controllers.clear()
    }, 'a2a.dispose')
    void this.reload()
  }

  /** Read-only status for the protocols page. */
  info() {
    return { sources: this.files, agents: this.agents }
  }

  /** Re-reads config and Agent Cards; drops tools from the previous pass. */
  async reload() {
    const generation = ++this.generation
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    const files = this.configFiles()
    this.files = files
    const groups: Array<{ path: string; agents: A2aAgentConfig[] }> = []
    for (const path of files) groups.push({ path, agents: await readA2aConfig(path) })
    const configs = mergeA2aConfigs(groups.map(group => ({ path: group.path, agents: group.agents })))
    const next: A2aAgentInfo[] = []

    for (const agent of configs) {
      if (agent.disabled) {
        next.push({
          id: agent.id,
          name: agent.name ?? agent.id,
          url: agent.url,
          tool: a2aToolName(agent.id),
          status: 'disabled',
          skills: [],
        })
        continue
      }
      const controller = new AbortController()
      this.controllers.add(controller)
      try {
        const card = await fetchAgentCard(agent.url, {
          headers: agent.headers,
          timeoutMs: this.config.cardTimeoutMs ?? 15_000,
          signal: controller.signal,
          allowPrivateHosts: agent.allowPrivateHosts,
        })
        if (generation !== this.generation) return
        const tool = createA2aTool(agent, card)
        this.disposers.push(this.ctx.tools.register(tool))
        next.push({
          id: agent.id,
          name: card.name,
          url: agent.url,
          tool: tool.name,
          status: 'ok',
          skills: card.skills,
        })
      } catch (error) {
        if (generation !== this.generation) return
        next.push({
          id: agent.id,
          name: agent.name ?? agent.id,
          url: agent.url,
          tool: a2aToolName(agent.id),
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          skills: [],
        })
      } finally {
        this.controllers.delete(controller)
      }
    }

    if (generation === this.generation) this.agents = next
  }

  private configFiles() {
    const workspaceRoot = this.config.workspaceRoot ?? process.cwd()
    const globalRoot = this.config.globalRoot ?? defaultGlobalRoot()
    return a2aConfigFiles(workspaceRoot, globalRoot)
  }
}

export default A2aService

export const meta = {
  title: 'A2A 远端智能体',
  description: '读取 .ruobai/a2a.json，把远端 Agent Card 注册成工具。',
}
