import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentService from '@ruobai/agent'
import ApprovalService from '@ruobai/approval'
import ChatService from '@ruobai/chat'
import ContextService from '@ruobai/context'
import { Context } from '@ruobai/cordis'
import LlmService from '@ruobai/llm'
import LlmCatalog from '@ruobai/llm-catalog'
import MockProvider from '@ruobai/llm-mock'
import ModeAgent from '@ruobai/mode-agent'
import ModeAsk from '@ruobai/mode-ask'
import ModeGoal from '@ruobai/mode-goal'
import ModePlan from '@ruobai/mode-plan'
import ModeService from '@ruobai/modes'
import SessionService from '@ruobai/session'
import SettingsService from '@ruobai/settings'
import SettingsWeb from '@ruobai/settings-web'
import ToolRegistry from '@ruobai/tools'
import FsTools from '@ruobai/tool-fs'
import UiApi from '@ruobai/ui-server'
import WebServer, { type Config as WebConfig } from '@ruobai/web-server'
import WebWs from '@ruobai/web-ws'
import WorkspaceService from '@ruobai/workspace'
import WorkspaceWeb from '@ruobai/workspace-web'

export interface Harness {
  ctx: Context
  settingsPath: string
  dispose(): Promise<void>
}

export interface HarnessOptions {
  delay?: number
  web?: Partial<WebConfig>
}

/**
 * Mount the full server-side stack used by the web tests: model, sessions,
 * tools, modes, context, approvals, agent, chat, and the HTTP adapters.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  const fibers: Array<{ dispose(): Promise<void> }> = []
  const dir = await mkdtemp(join(tmpdir(), 'rbh-harness-'))

  const mount = async (fiber: { dispose(): Promise<void> }) => {
    await fiber
    fibers.push(fiber)
  }

  await mount(ctx.plugin(LlmService, { provider: 'mock', model: 'mock-1' }))
  await mount(ctx.plugin(MockProvider, { delay: options.delay ?? 0 }))
  await mount(ctx.plugin(SessionService))
  await mount(ctx.plugin(ToolRegistry))
  await mount(ctx.plugin(FsTools, { root: process.cwd() }))
  await mount(ctx.plugin(SettingsService, { path: join(dir, 'settings.json') }))
  // Deterministic tests: ignore ambient keys and the seeded provider.
  await ctx.settings.update({ llm: { activeProvider: 'mock', activeModel: 'mock-1' } })
  await mount(ctx.plugin(WorkspaceService, { root: process.cwd() }))

  await mount(ctx.plugin(ModeService))
  await mount(ctx.plugin(ModeAsk))
  await mount(ctx.plugin(ModePlan))
  await mount(ctx.plugin(ModeAgent))
  await mount(ctx.plugin(ModeGoal))
  await mount(ctx.plugin(ContextService, { compactAt: 1_000_000 }))
  await mount(ctx.plugin(ApprovalService))
  await mount(ctx.plugin(AgentService, { maxSteps: 4 }))
  await mount(ctx.plugin(ChatService))
  await mount(ctx.plugin(LlmCatalog))

  await mount(ctx.plugin(WebServer, { port: 0, host: '127.0.0.1', ...options.web }))
  await mount(ctx.plugin(UiApi))
  await mount(ctx.plugin(WorkspaceWeb))
  await mount(ctx.plugin(SettingsWeb))
  await mount(ctx.plugin(WebWs))

  return {
    ctx,
    settingsPath: join(dir, 'settings.json'),
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
