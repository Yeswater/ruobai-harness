import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentService from '@ruobai/agent'
import A2aService from '@ruobai/a2a'
import A2aWeb from '@ruobai/a2a-web'
import ApprovalService from '@ruobai/approval'
import ChatService from '@ruobai/chat'
import CheckpointsService from '@ruobai/checkpoints'
import CheckpointsWeb from '@ruobai/checkpoints-web'
import ContextService from '@ruobai/context'
import { Context } from '@ruobai/cordis'
import GitService from '@ruobai/git'
import GitWeb from '@ruobai/git-web'
import GiteeService from '@ruobai/gitee'
import GiteeWeb from '@ruobai/gitee-web'
import HooksService from '@ruobai/hooks'
import HooksWeb from '@ruobai/hooks-web'
import LintService from '@ruobai/lint'
import LlmService from '@ruobai/llm'
import LlmCatalog from '@ruobai/llm-catalog'
import MemoryService from '@ruobai/memory'
import MockProvider from '@ruobai/llm-mock'
import McpService from '@ruobai/mcp'
import McpCatalog from '@ruobai/mcp-catalog'
import McpConfig from '@ruobai/mcp-config'
import McpWeb from '@ruobai/mcp-web'
import ModeAgent from '@ruobai/mode-agent'
import ModeAsk from '@ruobai/mode-ask'
import ModeGoal from '@ruobai/mode-goal'
import ModePlan from '@ruobai/mode-plan'
import ModeService from '@ruobai/modes'
import PermissionService from '@ruobai/permissions'
import SessionService from '@ruobai/session'
import SettingsService from '@ruobai/settings'
import ShellService from '@ruobai/shell'
import DirectShell from '@ruobai/shell-direct'
import SettingsWeb from '@ruobai/settings-web'
import SkillsService from '@ruobai/skills'
import SkillsWeb from '@ruobai/skills-web'
import ToolRegistry from '@ruobai/tools'
import BashTools from '@ruobai/tool-bash'
import FsTools from '@ruobai/tool-fs'
import ToolTask from '@ruobai/tool-task'
import Trajectory from '@ruobai/trajectory'
import TrajectoryWeb from '@ruobai/trajectory-web'
import UiApi from '@ruobai/ui-server'
import WebServer, { type Config as WebConfig } from '@ruobai/web-server'
import WebWs from '@ruobai/web-ws'
import WikiService from '@ruobai/wiki'
import WorkspaceService from '@ruobai/workspace'
import WorkspaceWeb from '@ruobai/workspace-web'

export interface Harness {
  ctx: Context
  /** Isolated temp directory used for settings and protocol roots. */
  dir: string
  settingsPath: string
  dispose(): Promise<void>
}

export interface HarnessOptions {
  delay?: number
  web?: Partial<WebConfig>
  /** Extra context-service config (retention budgets, pruning, ...). */
  context?: Record<string, unknown>
  /** Point the Gitee client at a local fixture in tests. */
  gitee?: {
    apiBase?: string
    allowPrivateHost?: boolean
    timeoutMs?: number
    remoteTemplate?: string
  }
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
  await mount(ctx.plugin(CheckpointsService, {
    root: process.cwd(),
    store: join(dir, 'checkpoints'),
  }))
  await mount(ctx.plugin(ToolRegistry))
  // The web tests exercise the direct executor: they assert on real command
  // output, not on Seatbelt behaviour (which has its own integration suite).
  await mount(ctx.plugin(ShellService))
  await mount(ctx.plugin(DirectShell, { shell: '/bin/sh' }))
  await mount(ctx.plugin(FsTools, { root: process.cwd() }))
  await mount(ctx.plugin(BashTools, { root: process.cwd() }))
  await mount(ctx.plugin(SettingsService, { path: join(dir, 'settings.json') }))
  // Deterministic tests: ignore ambient keys and the seeded provider.
  await ctx.settings.update({ llm: { activeProvider: 'mock', activeModel: 'mock-1' } })
  await mount(ctx.plugin(McpService))
  // Isolated protocol roots so tests never read the real ~/.ruobai or ~/.claude.
  const protocolHome = join(dir, 'ruobai-home')
  await mount(ctx.plugin(McpConfig, {
    workspaceRoot: dir,
    globalRoot: protocolHome,
    watchIntervalMs: 0,
  }))
  await mount(ctx.plugin(McpCatalog))
  await mount(ctx.plugin(WorkspaceService, { root: process.cwd() }))
  await mount(ctx.plugin(GitService))
  await mount(ctx.plugin(GiteeService, {
    ...(options.gitee?.apiBase ? { apiBase: options.gitee.apiBase } : {}),
    ...(options.gitee?.allowPrivateHost ? { allowPrivateHost: true } : {}),
    ...(options.gitee?.timeoutMs ? { timeoutMs: options.gitee.timeoutMs } : {}),
    ...(options.gitee?.remoteTemplate ? { remoteTemplate: options.gitee.remoteTemplate } : {}),
  }))
  await mount(ctx.plugin(SkillsService, {
    globalRoot: protocolHome,
    homeDir: dir,
    ttlMs: 0,
  }))
  await mount(ctx.plugin(A2aService, {
    workspaceRoot: dir,
    globalRoot: protocolHome,
    watchIntervalMs: 0,
  }))

  await mount(ctx.plugin(ModeService))
  await mount(ctx.plugin(ModeAsk))
  await mount(ctx.plugin(ModePlan))
  await mount(ctx.plugin(ModeAgent))
  await mount(ctx.plugin(ModeGoal))
  await mount(ctx.plugin(ContextService, {
    compactAt: 1_000_000,
    globalRoot: protocolHome,
    instructionsTtlMs: 0,
    ...options.context,
  }))
  // Memory and wiki keep their state under the temp protocol roots so tests
  // never touch the real ~/.ruobai or the checkout's .ruobai. They mount after
  // `context` so their prompt sections register synchronously.
  await mount(ctx.plugin(MemoryService, {
    globalRoot: protocolHome,
  }))
  await mount(ctx.plugin(WikiService, {
    root: join(dir, 'wiki'),
  }))
  await mount(ctx.plugin(ApprovalService))
  await mount(ctx.plugin(PermissionService))
  // Gates with no configured checkers: guard and lifecycle paths are exercised,
  // but no external toolchain runs in unit tests.
  await mount(ctx.plugin(LintService, { checkers: [] }))
  await mount(ctx.plugin(HooksService))
  await mount(ctx.plugin(AgentService))
  await mount(ctx.plugin(ToolTask))
  await mount(ctx.plugin(ChatService))
  await mount(ctx.plugin(LlmCatalog))

  await mount(ctx.plugin(WebServer, { port: 0, host: '127.0.0.1', ...options.web }))
  await mount(ctx.plugin(Trajectory))
  await mount(ctx.plugin(TrajectoryWeb))
  await mount(ctx.plugin(UiApi))
  await mount(ctx.plugin(HooksWeb))
  await mount(ctx.plugin(WorkspaceWeb))
  await mount(ctx.plugin(GitWeb))
  await mount(ctx.plugin(GiteeWeb))
  await mount(ctx.plugin(CheckpointsWeb))
  await mount(ctx.plugin(SettingsWeb))
  await mount(ctx.plugin(SkillsWeb))
  await mount(ctx.plugin(A2aWeb))
  await mount(ctx.plugin(WebWs))
  await mount(ctx.plugin(McpWeb))

  return {
    ctx,
    dir,
    settingsPath: join(dir, 'settings.json'),
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
