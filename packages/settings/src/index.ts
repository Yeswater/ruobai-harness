import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

export type ModelInput = 'text' | 'image'

export interface ProviderModel {
  id: string
  /** Display name used by the model picker; falls back to `id`. */
  name?: string
  /** Model context window in tokens, used by the context meter. */
  contextWindow?: number
  /** Per-request output cap in tokens. */
  maxOutputTokens?: number
  /** Accepted input kinds; absent means text only. */
  inputTypes?: ModelInput[]
}

export type ProviderMode = 'direct' | 'mapping'

export interface ProviderEntry {
  /** Stable identifier referenced by sessions. */
  id: string
  name: string
  note?: string
  website?: string
  baseUrl: string
  /** Write-only: never leaves the process through `get()`. */
  apiKey?: string
  mode: ProviderMode
  models: ProviderModel[]
}

export interface ProviderInput {
  id?: string
  name?: string
  note?: string
  website?: string
  baseUrl?: string
  apiKey?: string
  mode?: ProviderMode
  models?: Array<ProviderModel | string>
}

export interface LlmSettings {
  activeProvider?: string
  activeModel?: string
  providers?: ProviderEntry[]
  /** Legacy single-provider fields, migrated on startup. */
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
}

export interface UiSettings {
  theme?: 'light' | 'dark'
}

export interface SandboxSettings {
  /** Seatbelt confinement for agent commands. Off keeps approvals, drops the OS boundary. */
  enabled?: boolean
}

export type PermissionMode = 'read-only' | 'workspace-write' | 'full-access' | 'auto-review'

/** Extra character accepted as a slash-command trigger, next to `/` and `／`. */
export type CommandPrefix = '～' | '！' | '#'

export interface AgentSettings {
  /** Mode used for new sessions. */
  defaultMode?: string
  /** Permission preset applied to sessions without their own mode. */
  defaultPermission?: PermissionMode
  /** IME-friendly alternate trigger for slash commands. */
  commandPrefix?: CommandPrefix
  /** Compact when estimated tokens reach this percentage of the model window. */
  compactPercent?: number
  /** Absolute fallback when the model has no configured context window. */
  compactAt?: number
  /** Skip write approvals entirely. Dangerous; surfaced in settings as bypass. */
  bypassApprovals?: boolean
}

export type ApprovalAction = 'allow' | 'ask' | 'deny'
export type ApprovalMatch = 'exact' | 'prefix' | 'glob' | 'contains'

export interface ApprovalRule {
  id: string
  /** Tool name, e.g. `bash`, `write_file`, `edit_file`. */
  tool: string
  match: ApprovalMatch
  /** Command text or workspace-relative path. */
  pattern: string
  /** What a matching call does: run, prompt, or block. */
  action: ApprovalAction
  note?: string
  createdAt: number
}

export interface ApprovalRuleInput {
  tool?: string
  match?: ApprovalMatch
  pattern?: string
  action?: ApprovalAction
  note?: string
}

export interface ApprovalGuard {
  /** Built-in ask rules for dangerous commands, enforced even when approvals are bypassed. */
  enabled?: boolean
}

export interface ApprovalSettings {
  rules?: ApprovalRule[]
  guard?: ApprovalGuard
}

export type McpApproval = 'auto' | 'always' | 'never'

export interface McpServerEntry {
  /** Stable id, also used in the `mcp__<id>__<tool>` tool name. */
  id: string
  label?: string
  command: string
  args?: string[]
  /** Write-only: values reach the child process but never the browser. */
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  approval?: McpApproval
  disabled?: boolean
  restart?: boolean
}

export interface McpServerInput {
  id?: string
  label?: string
  command?: string
  args?: string[]
  /** Undefined keeps the stored env; an object replaces it. */
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  approval?: McpApproval
  disabled?: boolean
  restart?: boolean
}

export interface PublicMcpServer extends Omit<McpServerEntry, 'env'> {
  envKeys: string[]
  hasEnv: boolean
}

export interface McpSettings {
  servers?: McpServerEntry[]
}

export interface PublicMcpSettings {
  servers: PublicMcpServer[]
}

export interface SettingsData {
  llm?: LlmSettings
  ui?: UiSettings
  agent?: AgentSettings
  sandbox?: SandboxSettings
  approval?: ApprovalSettings
  mcp?: McpSettings
  hooks?: HookSettings
  gitee?: GiteeSettings
}

export type HookFailurePolicy = 'open' | 'close'
export type HookAuditTrigger = 'stop' | 'manual' | 'off'

export interface HookLayerSettings {
  enabled?: boolean
  timeoutMs?: number
  failure?: HookFailurePolicy
  /** Cap on diagnostics handed back to the model in one round. */
  maxDiagnostics?: number
  /** Stop layer only: blocking rounds before escalation. */
  maxRounds?: number
}

export interface HookGuardSettings {
  enabled?: boolean
  /** Workspace-relative globs the agent may not write. */
  denyWrite?: string[]
  /** Command fragments rejected before execution. */
  denyCommand?: string[]
}

export interface HookAuditSettings {
  enabled?: boolean
  provider?: string
  model?: string
  trigger?: HookAuditTrigger
  prompt?: string
  maxFiles?: number
  dailyBudget?: number
  /** Hand audit findings back to the model on the next round. */
  feedback?: boolean
}

export interface HookSettings {
  enabled?: boolean
  edit?: HookLayerSettings
  stop?: HookLayerSettings
  guard?: HookGuardSettings
  audit?: HookAuditSettings
}

export type GiteeVisibility = 'public' | 'private'

export interface GiteeSettings {
  /** Write-only: never returned by `get()`. */
  token?: string
  /** Default namespace for creating repositories. */
  owner?: string
  apiBase?: string
  visibility?: GiteeVisibility
}

export interface PublicGiteeSettings {
  hasToken: boolean
  owner?: string
  apiBase?: string
  visibility: GiteeVisibility
}

export interface PublicProvider {
  id: string
  name: string
  note?: string
  website?: string
  baseUrl: string
  mode: ProviderMode
  models: ProviderModel[]
  hasApiKey: boolean
}

export interface PublicSettings {
  llm?: {
    activeProvider?: string
    activeModel?: string
    providers: PublicProvider[]
  }
  ui?: UiSettings
  agent?: AgentSettings
  sandbox?: SandboxSettings
  approval?: { rules: ApprovalRule[]; guard: { enabled: boolean } }
  mcp?: PublicMcpSettings
  hooks?: HookSettings
  gitee?: PublicGiteeSettings
}

export interface Config {
  path?: string
}

export class SettingsError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

declare module '@ruobai/cordis' {
  interface Context {
    settings: SettingsService
  }

  interface Events {
    'settings/updated'(settings: PublicSettings): void
  }
}

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'

/** Shell control and expansion characters that make prefix matching unsafe. */
const CONTROL_CHARACTERS = /[;&|<>`$()\\\n\r]/

/** JSON-file settings with write-only secrets and provider CRUD. */
export class SettingsService extends Service {
  static Config: z<Config> = z.object({
    path: z.string().default('.ruobai/settings.json'),
  })

  readonly path: string
  private data: SettingsData = {}
  private queue: Promise<void> = Promise.resolve()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'settings')
    this.path = resolve(config.path ?? '.ruobai/settings.json')
  }

  async *[Service.init]() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      if (parsed && typeof parsed === 'object') this.data = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.ctx.logger('settings').warn(error)
      }
    }

    if (this.migrate()) await this.persist()
    yield () => undefined
  }

  raw(): SettingsData {
    return structuredClone(this.data)
  }

  rawProviders(): ProviderEntry[] {
    return structuredClone(this.data.llm?.providers ?? [])
  }

  findProvider(id: string): ProviderEntry | undefined {
    return this.data.llm?.providers?.find(entry => entry.id === id)
  }

  /** Effective key: stored value, then environment fallbacks. */
  apiKeyFor(id: string): string | undefined {
    const entry = this.findProvider(id)
    return entry?.apiKey
      || process.env.RBU_API_KEY
      || (entry?.baseUrl?.includes('deepseek') || id === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined)
  }

  get(): PublicSettings {
    const llm = this.data.llm
    const result: PublicSettings = {}
    if (llm) {
      result.llm = {
        activeProvider: llm.activeProvider,
        activeModel: llm.activeModel,
        providers: (llm.providers ?? []).map(entry => this.publicProvider(entry)),
      }
    }
    if (this.data.ui) result.ui = { ...this.data.ui }
    if (this.data.agent) result.agent = { ...this.data.agent }
    if (this.data.sandbox) result.sandbox = { ...this.data.sandbox }
    if (this.data.approval) {
      result.approval = {
        rules: structuredClone(this.data.approval.rules ?? []),
        guard: this.approvalGuard(),
      }
    }
    if (this.data.mcp) {
      result.mcp = {
        servers: (this.data.mcp.servers ?? []).map(entry => this.publicMcpServer(entry)),
      }
    }
    if (this.data.hooks) result.hooks = structuredClone(this.data.hooks)
    if (this.data.gitee || process.env.GITEE_TOKEN) result.gitee = this.publicGitee()
    return result
  }

  publicProvider(entry: ProviderEntry): PublicProvider {
    const { apiKey, ...rest } = entry
    return { ...rest, hasApiKey: Boolean(this.apiKeyFor(entry.id)) }
  }

  sandboxEnabled(): boolean {
    return this.data.sandbox?.enabled !== false
  }

  async update(patch: {
    llm?: { activeProvider?: string; activeModel?: string }
    ui?: UiSettings
    agent?: AgentSettings
    sandbox?: SandboxSettings
  }): Promise<PublicSettings> {
    const llm = this.data.llm ??= {}
    if (patch.llm?.activeProvider !== undefined) llm.activeProvider = patch.llm.activeProvider || 'mock'
    if (patch.llm?.activeModel !== undefined) llm.activeModel = patch.llm.activeModel || undefined
    if (patch.ui) this.data.ui = { ...this.data.ui, ...patch.ui }
    if (patch.agent) {
      const agent = this.data.agent ??= {}
      if (patch.agent.defaultMode !== undefined) agent.defaultMode = patch.agent.defaultMode || undefined
      if (patch.agent.defaultPermission !== undefined) {
        agent.defaultPermission = patch.agent.defaultPermission || undefined
      }
      if (patch.agent.commandPrefix !== undefined) {
        agent.commandPrefix = patch.agent.commandPrefix || undefined
      }
      if (patch.agent.compactPercent !== undefined) {
        const percent = Number(patch.agent.compactPercent)
        agent.compactPercent = Number.isFinite(percent)
          ? Math.min(100, Math.max(1, Math.round(percent)))
          : undefined
      }
      if (patch.agent.bypassApprovals !== undefined) agent.bypassApprovals = Boolean(patch.agent.bypassApprovals)
      if (patch.agent.compactAt !== undefined) agent.compactAt = Math.max(1000, Number(patch.agent.compactAt) || 0) || undefined
    }
    if (patch.sandbox) {
      const sandbox = this.data.sandbox ??= {}
      if (patch.sandbox.enabled !== undefined) sandbox.enabled = Boolean(patch.sandbox.enabled)
    }
    return this.commit()
  }

  async upsertProvider(input: ProviderInput, id?: string): Promise<PublicSettings> {
    const llm = this.data.llm ??= {}
    const providers = llm.providers ??= []

    const targetId = (id ?? input.id)?.trim() || this.uniqueId(slug(input.name || 'provider'))
    const existing = providers.find(entry => entry.id === targetId)
    const name = (input.name ?? existing?.name ?? targetId).trim()
    if (!name) throw new SettingsError(400, 'provider name is required')

    const baseUrl = normalizeBaseUrl(input.baseUrl ?? existing?.baseUrl)
    const models = normalizeModels(input.models ?? existing?.models)
    const mode = input.mode ?? existing?.mode ?? 'direct'
    if (mode !== 'direct' && mode !== 'mapping') throw new SettingsError(400, 'invalid provider mode')

    const entry: ProviderEntry = {
      id: targetId,
      name,
      baseUrl,
      mode,
      models,
      ...(input.note !== undefined ? { note: input.note } : existing?.note ? { note: existing.note } : {}),
      ...(input.website !== undefined ? { website: input.website } : existing?.website ? { website: existing.website } : {}),
      ...(input.apiKey === undefined
        ? existing?.apiKey ? { apiKey: existing.apiKey } : {}
        : input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {}),
    }

    const index = providers.findIndex(item => item.id === targetId)
    if (index >= 0) providers[index] = entry
    else providers.push(entry)

    if (!llm.activeProvider || llm.activeProvider === 'mock') {
      llm.activeProvider = targetId
      llm.activeModel = models[0]?.id
    } else if (llm.activeProvider === targetId && (!llm.activeModel || !models.some(model => model.id === llm.activeModel))) {
      llm.activeModel = models[0]?.id
    }

    return this.commit()
  }

  async removeProvider(id: string): Promise<PublicSettings> {
    const llm = this.data.llm ??= {}
    llm.providers = (llm.providers ?? []).filter(entry => entry.id !== id)
    if (llm.activeProvider === id) {
      const next = llm.providers[0]
      llm.activeProvider = next?.id ?? 'mock'
      llm.activeModel = next?.models[0]?.id
    }
    return this.commit()
  }

  async activate(providerId: string, model?: string): Promise<PublicSettings> {
    const llm = this.data.llm ??= {}
    if (providerId === 'mock') {
      llm.activeProvider = 'mock'
      llm.activeModel = model || 'mock-1'
      return this.commit()
    }

    const entry = this.findProvider(providerId)
    if (!entry) throw new SettingsError(404, `unknown provider: ${providerId}`)
    const selected = model?.trim() || entry.models[0]?.id
    if (model?.trim() && !entry.models.some(item => item.id === model.trim())) {
      throw new SettingsError(400, `model "${model}" is not in provider "${providerId}"`)
    }
    llm.activeProvider = providerId
    llm.activeModel = selected
    return this.commit()
  }

  flush() {
    return this.queue
  }

  mcpServers(): McpServerEntry[] {
    return structuredClone(this.data.mcp?.servers ?? [])
  }

  findMcpServer(id: string): McpServerEntry | undefined {
    return this.data.mcp?.servers?.find(entry => entry.id === id)
  }

  publicMcpServer(entry: McpServerEntry): PublicMcpServer {
    const { env, ...rest } = entry
    const envKeys = Object.keys(env ?? {})
    return { ...rest, envKeys, hasEnv: envKeys.length > 0 }
  }

  async upsertMcpServer(input: McpServerInput, id?: string): Promise<PublicSettings> {
    const mcp = this.data.mcp ??= {}
    const servers = mcp.servers ??= []

    const requested = (id ?? input.id ?? '').trim()
    const existing = requested ? servers.find(entry => entry.id === requested) : undefined
    if (id && !existing) throw new SettingsError(404, `unknown MCP server: ${id}`)

    const base = input.label?.trim() || input.command?.trim().split(/[\\/]/).pop() || 'mcp'
    const targetId = existing?.id ?? (requested || this.uniqueMcpId(slug(base)))
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(targetId)) {
      throw new SettingsError(400, 'MCP server id may only contain letters, digits, _ and -')
    }

    const command = (input.command ?? existing?.command ?? '').trim()
    if (!command) throw new SettingsError(400, 'MCP command is required')
    if (command.length > 500) throw new SettingsError(400, 'MCP command is too long')

    const args = normalizeArgs(input.args ?? existing?.args)
    const env = input.env === undefined ? existing?.env : normalizeEnv(input.env)
    const cwd = input.cwd !== undefined ? input.cwd.trim() || undefined : existing?.cwd
    const timeoutMs = input.timeoutMs !== undefined
      ? normalizeTimeout(input.timeoutMs)
      : existing?.timeoutMs ?? 60_000
    const approval = normalizeApproval(input.approval ?? existing?.approval)
    const disabled = input.disabled !== undefined ? Boolean(input.disabled) : Boolean(existing?.disabled)
    const restart = input.restart !== undefined ? Boolean(input.restart) : existing?.restart !== false
    const label = (input.label ?? existing?.label ?? targetId).trim() || targetId

    const entry: McpServerEntry = {
      id: targetId,
      label,
      command,
      args,
      timeoutMs,
      approval,
      disabled,
      restart,
      ...(cwd ? { cwd } : {}),
      ...(env && Object.keys(env).length ? { env } : {}),
    }

    const index = servers.findIndex(item => item.id === targetId)
    if (index >= 0) servers[index] = entry
    else servers.push(entry)

    return this.commit()
  }

  async removeMcpServer(id: string): Promise<PublicSettings> {
    const mcp = this.data.mcp ??= {}
    mcp.servers = (mcp.servers ?? []).filter(entry => entry.id !== id)
    return this.commit()
  }

  approvalRules(): ApprovalRule[] {
    return structuredClone(this.data.approval?.rules ?? [])
  }

  approvalGuard(): { enabled: boolean } {
    return { enabled: this.data.approval?.guard?.enabled !== false }
  }

  async updateApprovalGuard(input: ApprovalGuard): Promise<PublicSettings> {
    const approval = this.data.approval ??= {}
    const guard = approval.guard ??= { enabled: true }
    if (input.enabled !== undefined) guard.enabled = Boolean(input.enabled)
    return this.commit()
  }

  async updateHooks(patch: HookSettings): Promise<PublicSettings> {
    const current = this.data.hooks ?? {}
    const next: HookSettings = { ...current }
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled)
    if (patch.edit) next.edit = mergeHookLayer(current.edit, patch.edit)
    if (patch.stop) next.stop = { ...mergeHookLayer(current.stop, patch.stop) }
    if (patch.guard) {
      next.guard = {
        ...current.guard,
        ...(patch.guard.enabled !== undefined ? { enabled: Boolean(patch.guard.enabled) } : {}),
        ...(patch.guard.denyWrite !== undefined
          ? { denyWrite: normalizeStringList(patch.guard.denyWrite) }
          : {}),
        ...(patch.guard.denyCommand !== undefined
          ? { denyCommand: normalizeStringList(patch.guard.denyCommand) }
          : {}),
      }
    }
    if (patch.audit) next.audit = mergeAuditSettings(current.audit, patch.audit)
    this.data.hooks = next
    return this.commit()
  }

  publicGitee(): PublicGiteeSettings {
    const gitee = this.data.gitee
    return {
      hasToken: Boolean(this.giteeToken()),
      ...(gitee?.owner ? { owner: gitee.owner } : {}),
      ...(gitee?.apiBase ? { apiBase: gitee.apiBase } : {}),
      visibility: gitee?.visibility === 'private' ? 'private' : 'public',
    }
  }

  /** Host-only: the token never appears in the public settings view. */
  giteeToken(): string | undefined {
    return this.data.gitee?.token || process.env.GITEE_TOKEN || undefined
  }

  async updateGitee(patch: {
    token?: string
    clearToken?: boolean
    owner?: string
    apiBase?: string
    visibility?: GiteeVisibility
  }): Promise<PublicSettings> {
    const gitee = this.data.gitee ??= {}
    if (patch.clearToken) delete gitee.token
    else if (typeof patch.token === 'string' && patch.token.trim()) gitee.token = patch.token.trim()

    if (patch.owner !== undefined) {
      const owner = patch.owner.trim()
      if (owner) gitee.owner = owner
      else delete gitee.owner
    }

    if (patch.apiBase !== undefined) {
      const base = patch.apiBase.trim()
      if (base) gitee.apiBase = normalizeBaseUrl(base)
      else delete gitee.apiBase
    }

    if (patch.visibility !== undefined) {
      gitee.visibility = patch.visibility === 'private' ? 'private' : 'public'
    }

    return this.commit()
  }

  async upsertApprovalRule(input: ApprovalRuleInput, id?: string): Promise<PublicSettings> {
    const approval = this.data.approval ??= {}
    const rules = approval.rules ??= []

    const requested = (id ?? '').trim()
    const existing = requested ? rules.find(rule => rule.id === requested) : undefined
    if (id && !existing) throw new SettingsError(404, `unknown approval rule: ${id}`)

    const tool = (input.tool ?? existing?.tool ?? '').trim()
    if (!tool) throw new SettingsError(400, 'approval rule tool is required')
    if (tool.length > 200 || /\s/.test(tool)) throw new SettingsError(400, 'invalid approval rule tool')

    const match = input.match ?? existing?.match ?? 'exact'
    if (match !== 'exact' && match !== 'prefix' && match !== 'glob' && match !== 'contains') {
      throw new SettingsError(400, 'approval match must be exact, prefix, glob or contains')
    }

    const action = input.action ?? existing?.action ?? 'allow'
    if (action !== 'allow' && action !== 'ask' && action !== 'deny') {
      throw new SettingsError(400, 'approval action must be allow, ask or deny')
    }

    const pattern = (input.pattern ?? existing?.pattern ?? '').trim()
    if (!pattern) throw new SettingsError(400, 'approval rule pattern is required')
    if (pattern.length > 2_000) throw new SettingsError(400, 'approval rule pattern is too long')
    if (match === 'prefix' && CONTROL_CHARACTERS.test(pattern)) {
      throw new SettingsError(400, 'prefix rules cannot contain shell operators')
    }
    if (match === 'glob' && (pattern.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(pattern) || pattern.includes('\\'))) {
      throw new SettingsError(400, 'glob rules must be relative workspace paths')
    }

    const note = input.note === undefined ? existing?.note : input.note.trim() || undefined
    if (note && note.length > 500) throw new SettingsError(400, 'approval rule note is too long')

    const duplicate = rules.find(rule =>
      rule.id !== existing?.id
      && rule.tool === tool
      && rule.match === match
      && rule.pattern === pattern
      && rule.action === action)
    if (duplicate) {
      // Editing a rule into an existing one collapses them instead of silently
      // discarding the edit.
      if (existing) approval.rules = rules.filter(rule => rule.id !== existing.id)
      return this.commit()
    }

    if (existing) {
      existing.tool = tool
      existing.match = match
      existing.pattern = pattern
      existing.action = action
      if (note) existing.note = note
      else delete existing.note
    } else {
      if (rules.length >= 200) throw new SettingsError(400, 'too many approval rules')
      rules.push({
        id: randomUUID(),
        tool,
        match,
        pattern,
        action,
        ...(note ? { note } : {}),
        createdAt: Date.now(),
      })
    }

    return this.commit()
  }

  async removeApprovalRule(id: string): Promise<PublicSettings> {
    const approval = this.data.approval ??= {}
    approval.rules = (approval.rules ?? []).filter(rule => rule.id !== id)
    return this.commit()
  }

  private async commit() {
    const snapshot = this.get()
    this.queue = this.queue
      .then(() => this.persist())
      .catch(error => this.ctx.logger('settings').error(error))
    this.ctx.emit('settings/updated', snapshot)
    await this.queue
    return snapshot
  }

  private async persist() {
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.data, null, 2) + '\n')
    await rename(temp, this.path)
  }

  /** Seed defaults or convert the legacy single-provider shape. Returns true if changed. */
  private migrate() {
    const llm = this.data.llm ??= {}
    let changed = false

    if (!llm.providers?.length) {
      if (llm.provider || llm.model || llm.baseUrl || llm.apiKey) {
        const model = llm.model?.trim()
        const id = this.uniqueId(slug(llm.provider || 'provider'))
        llm.providers = [{
          id,
          name: llm.provider || 'Provider',
          baseUrl: llm.baseUrl?.trim()
            || (model?.toLowerCase().includes('deepseek') ? DEEPSEEK_BASE : 'https://api.openai.com/v1'),
          mode: 'direct',
          models: model ? [{ id: model }] : [],
          ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
        }]
        llm.activeProvider = id
        llm.activeModel = model
      } else {
        llm.providers = [{
          id: 'deepseek',
          name: 'DeepSeek',
          website: 'https://platform.deepseek.com',
          baseUrl: process.env.RBU_BASE_URL ?? DEEPSEEK_BASE,
          mode: 'direct',
          models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        }]
        llm.activeProvider = process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'mock'
        llm.activeModel = process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : undefined
      }
      changed = true
    }

    for (const key of ['provider', 'model', 'baseUrl', 'apiKey'] as const) {
      if (key in llm) {
        delete llm[key]
        changed = true
      }
    }
    if (!llm.activeProvider) {
      llm.activeProvider = 'mock'
      changed = true
    }

    if (!this.data.agent) {
      this.data.agent = { defaultMode: 'agent', bypassApprovals: false, compactAt: 48_000 }
      changed = true
    }

    if (!this.data.mcp) {
      this.data.mcp = { servers: [] }
      changed = true
    }

    if (!this.data.approval) {
      this.data.approval = { rules: [], guard: { enabled: true } }
      changed = true
    }

    if (!Array.isArray(this.data.approval.rules)) {
      this.data.approval.rules = []
      changed = true
    } else {
      const rules = this.data.approval.rules.filter(rule =>
        rule && typeof rule === 'object'
        && typeof rule.id === 'string' && rule.id
        && typeof rule.tool === 'string' && rule.tool
        && (rule.match === 'exact' || rule.match === 'prefix' || rule.match === 'glob' || rule.match === 'contains')
        && typeof rule.pattern === 'string')
      if (rules.length !== this.data.approval.rules.length) {
        this.data.approval.rules = rules
        changed = true
      }
      for (const rule of this.data.approval.rules) {
        if (rule.action !== 'allow' && rule.action !== 'ask' && rule.action !== 'deny') {
          rule.action = 'allow'
          changed = true
        }
      }
    }

    const guard = this.data.approval.guard ??= {}
    if (typeof guard.enabled !== 'boolean') {
      guard.enabled = true
      changed = true
    }

    // The first guard version stored extra substrings separately; they are now
    // ordinary ask rules so every policy lives in one list.
    const legacyExtra = (guard as { extra?: unknown }).extra
    if (Array.isArray(legacyExtra)) {
      for (const raw of legacyExtra) {
        if (typeof raw !== 'string') continue
        const pattern = raw.trim()
        if (!pattern) continue
        const exists = this.data.approval.rules.some(rule =>
          rule.tool === 'bash'
          && rule.match === 'contains'
          && rule.pattern === pattern
          && rule.action === 'ask')
        if (exists) continue
        this.data.approval.rules.push({
          id: randomUUID(),
          tool: 'bash',
          match: 'contains',
          pattern,
          action: 'ask',
          note: '从旧版守卫迁移',
          createdAt: Date.now(),
        })
      }
      delete (guard as { extra?: unknown }).extra
      changed = true
    }

    return changed
  }

  private uniqueId(base: string) {
    const providers = this.data.llm?.providers ?? []
    let id = base || 'provider'
    let index = 2
    while (providers.some(entry => entry.id === id)) id = `${base}-${index++}`
    return id
  }

  private uniqueMcpId(base: string) {
    const servers = this.data.mcp?.servers ?? []
    let id = base || 'mcp'
    let index = 2
    while (servers.some(entry => entry.id === id)) id = `${base}-${index++}`
    return id
  }
}

function slug(value: string) {
  const slugged = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slugged || 'provider'
}

function normalizeBaseUrl(value: string | undefined) {
  const url = value?.trim().replace(/\/+$/, '')
  if (!url) throw new SettingsError(400, 'base URL is required')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SettingsError(400, `invalid base URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SettingsError(400, 'base URL must be http(s)')
  }
  return url
}

function normalizeModels(models: Array<ProviderModel | string> | undefined): ProviderModel[] {
  const seen = new Set<string>()
  const result: ProviderModel[] = []
  for (const item of models ?? []) {
    if (!item) continue
    const raw = typeof item === 'string' ? { id: item } : item
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: ProviderModel = { id }
    if (typeof raw.name === 'string' && raw.name.trim()) model.name = raw.name.trim().slice(0, 200)
    const contextWindow = positiveInt(raw.contextWindow)
    if (contextWindow) model.contextWindow = contextWindow
    const maxOutputTokens = positiveInt(raw.maxOutputTokens)
    if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens
    if (Array.isArray(raw.inputTypes)) {
      const types = [...new Set(raw.inputTypes.filter(
        (type): type is ModelInput => type === 'text' || type === 'image',
      ))]
      model.inputTypes = types.length ? types : ['text']
    }
    result.push(model)
  }
  return result
}

function positiveInt(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined
}

function normalizeArgs(args: string[] | undefined): string[] {
  if (!Array.isArray(args)) return []
  const result = args
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
  if (result.length > 64) throw new SettingsError(400, 'too many MCP arguments')
  if (result.some(item => item.length > 2_000)) throw new SettingsError(400, 'MCP argument is too long')
  return result
}

function normalizeEnv(env: Record<string, string>): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new SettingsError(400, 'MCP env must be an object')
  }
  const entries = Object.entries(env)
  if (entries.length > 32) throw new SettingsError(400, 'too many MCP environment variables')
  const result: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SettingsError(400, `invalid MCP env name: ${key}`)
    }
    const text = String(value ?? '')
    if (text.length > 4_000) throw new SettingsError(400, `MCP env ${key} is too long`)
    result[key] = text
  }
  return result
}

function normalizeTimeout(value: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 60_000
  return Math.min(Math.max(1_000, number), 600_000)
}

function normalizeApproval(value: McpApproval | undefined): McpApproval {
  return value === 'always' || value === 'never' ? value : 'auto'
}

function mergeHookLayer(current: HookLayerSettings | undefined, patch: HookLayerSettings): HookLayerSettings {
  const next: HookLayerSettings = { ...current }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled)
  if (patch.timeoutMs !== undefined) next.timeoutMs = clampInt(patch.timeoutMs, 100, 600_000, 4000)
  if (patch.failure === 'open' || patch.failure === 'close') next.failure = patch.failure
  if (patch.maxDiagnostics !== undefined) next.maxDiagnostics = clampInt(patch.maxDiagnostics, 1, 100, 20)
  if (patch.maxRounds !== undefined) next.maxRounds = clampInt(patch.maxRounds, 0, 5, 2)
  return next
}

function mergeAuditSettings(
  current: HookAuditSettings | undefined,
  patch: HookAuditSettings,
): HookAuditSettings {
  const next: HookAuditSettings = { ...current }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled)
  if (patch.provider !== undefined) next.provider = patch.provider.trim() || undefined
  if (patch.model !== undefined) next.model = patch.model.trim() || undefined
  if (patch.trigger === 'stop' || patch.trigger === 'manual' || patch.trigger === 'off') {
    next.trigger = patch.trigger
  }
  if (patch.prompt !== undefined) next.prompt = patch.prompt.slice(0, 4000).trim() || undefined
  if (patch.maxFiles !== undefined) next.maxFiles = clampInt(patch.maxFiles, 1, 200, 20)
  if (patch.dailyBudget !== undefined) next.dailyBudget = clampInt(patch.dailyBudget, 0, 10_000, 50)
  if (patch.feedback !== undefined) next.feedback = Boolean(patch.feedback)
  return next
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > 200) continue
    seen.add(trimmed)
    if (seen.size >= 100) break
  }
  return [...seen]
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

export default SettingsService

export const meta = {
  title: '设置服务',
  description: '读写本地设置与供应商配置。',
}
