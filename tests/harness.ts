import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentService from '@ruobai/agent'
import A2aService from '@ruobai/a2a'
import A2aWeb from '@ruobai/a2a-web'
import ApprovalService from '@ruobai/approval'
import AskService from '@ruobai/ask'
import AskWeb from '@ruobai/ask-web'
import ChatService from '@ruobai/chat'
import CheckpointsService from '@ruobai/checkpoints'
import CheckpointsWeb from '@ruobai/checkpoints-web'
import CommandService from '@ruobai/commands'
import CommitPromptService from '@ruobai/commit-prompt'
import CommitPromptWeb from '@ruobai/commit-prompt-web'
import ContextSearch from '@ruobai/context-search'
import ContextService from '@ruobai/context'
import ContractService from '@ruobai/contract'
import DeliveryService from '@ruobai/delivery'
import DeliveryWeb from '@ruobai/delivery-web'
import { Context } from '@ruobai/cordis'
import GitService from '@ruobai/git'
import GitWeb from '@ruobai/git-web'
import GiteeService from '@ruobai/gitee'
import GiteeWeb from '@ruobai/gitee-web'
import HandoffService from '@ruobai/handoff'
import HooksService from '@ruobai/hooks'
import HooksWeb from '@ruobai/hooks-web'
import LintService from '@ruobai/lint'
import LlmService from '@ruobai/llm'
import LlmCatalog from '@ruobai/llm-catalog'
import MemoryService from '@ruobai/memory'
import MemoryDistill from '@ruobai/memory-distill'
import MemoryWeb from '@ruobai/memory-web'
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
import PlanService from '@ruobai/plan'
import PlanWeb from '@ruobai/plan-web'
import PreviewService from '@ruobai/preview'
import PreviewWeb from '@ruobai/preview-web'
import SessionService from '@ruobai/session'
import SessionExport from '@ruobai/session-export'
import SecretsService from '@ruobai/secrets'
import SettingsService from '@ruobai/settings'
import ShellService from '@ruobai/shell'
import DirectShell from '@ruobai/shell-direct'
import SettingsWeb from '@ruobai/settings-web'
import SkillsService from '@ruobai/skills'
import SkillsWeb from '@ruobai/skills-web'
import ToolRegistry from '@ruobai/tools'
import BashTools from '@ruobai/tool-bash'
import BrowserPreview from '@ruobai/browser-preview'
import FsTools from '@ruobai/tool-fs'
import TerminalService from '@ruobai/terminal'
import TerminalWeb from '@ruobai/terminal-web'
import Todo from '@ruobai/todo'
import TodoWeb from '@ruobai/todo-web'
import ToolTask from '@ruobai/tool-task'
import Trajectory from '@ruobai/trajectory'
import TrajectoryWeb from '@ruobai/trajectory-web'
import UiApi from '@ruobai/ui-server'
import WebServer, { type Config as WebConfig } from '@ruobai/web-server'
import WebWs from '@ruobai/web-ws'
import WikiService from '@ruobai/wiki'
import WikiAutomation from '@ruobai/wiki-automation'
import WikiWeb from '@ruobai/wiki-web'
import WorkspaceService from '@ruobai/workspace'
import WorkspaceWeb from '@ruobai/workspace-web'

export interface Harness {
  ctx: Context
  /** Isolated temp directory used for settings and protocol roots. */
  dir: string
  settingsPath: string
  secretsPath: string
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
  await mount(ctx.plugin(CommandService))
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
  // File backend: tests must never touch the developer's login keychain.
  await mount(ctx.plugin(SecretsService, { provider: 'file', path: join(dir, 'secrets.json') }))
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
  // Rules mode is free and offline; the idle timer is long enough that unit
  // tests never depend on it.
  await mount(ctx.plugin(MemoryDistill, {
    writeMode: 'rules',
    idleMs: 3_600_000,
    minIntervalMs: 0,
  }))
  await mount(ctx.plugin(WikiService, {
    root: join(dir, 'wiki'),
  }))
  await mount(ctx.plugin(WikiAutomation, {
    idleMs: 0,
    minTurns: 1,
    minIntervalMs: 0,
  }))
  await mount(ctx.plugin(ContextSearch))
  await mount(ctx.plugin(ApprovalService))
  await mount(ctx.plugin(AskService))
  await mount(ctx.plugin(PermissionService))
  // Gates with no configured checkers: guard and lifecycle paths are exercised,
  // but no external toolchain runs in unit tests.
  await mount(ctx.plugin(LintService, { checkers: [] }))
  await mount(ctx.plugin(HooksService))
  await mount(ctx.plugin(DeliveryService))
  await mount(ctx.plugin(DeliveryWeb))
  await mount(ctx.plugin(AgentService))
  await mount(ctx.plugin(ToolTask))
  await mount(ctx.plugin(Todo))
  await mount(ctx.plugin(ContractService))
  await mount(ctx.plugin(PlanService))
  await mount(ctx.plugin(BrowserPreview, { waitMs: 50 }))
  await mount(ctx.plugin(TerminalService, { root: dir }))
  await mount(ctx.plugin(TerminalWeb))
  await mount(ctx.plugin(PreviewService, { root: dir, startTimeoutMs: 10_000 }))
  await mount(ctx.plugin(PreviewWeb))
  await mount(ctx.plugin(ChatService))
  await mount(ctx.plugin(LlmCatalog))

  await mount(ctx.plugin(WebServer, { port: 0, host: '127.0.0.1', ...options.web }))
  await mount(ctx.plugin(Trajectory))
  await mount(ctx.plugin(TrajectoryWeb))
  await mount(ctx.plugin(UiApi))
  await mount(ctx.plugin(AskWeb))
  await mount(ctx.plugin(PlanWeb))
  await mount(ctx.plugin(HooksWeb))
  await mount(ctx.plugin(WorkspaceWeb))
  await mount(ctx.plugin(GitWeb))
  await mount(ctx.plugin(GiteeWeb))
  await mount(ctx.plugin(CheckpointsWeb))
  await mount(ctx.plugin(SettingsWeb))
  await mount(ctx.plugin(SkillsWeb))
  await mount(ctx.plugin(MemoryWeb))
  await mount(ctx.plugin(WikiWeb))
  await mount(ctx.plugin(A2aWeb))
  await mount(ctx.plugin(WebWs))
  await mount(ctx.plugin(CommitPromptService))
  await mount(ctx.plugin(CommitPromptWeb))
  await mount(ctx.plugin(McpWeb))
  await mount(ctx.plugin(TodoWeb))
  await mount(ctx.plugin(SessionExport))
  await mount(ctx.plugin(HandoffService))

  return {
    ctx,
    dir,
    settingsPath: join(dir, 'settings.json'),
    secretsPath: join(dir, 'secrets.json'),
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
