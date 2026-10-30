import type {
  AttachmentMeta, ChatEvent, ChatMessage, ChatSession, QueuedMessage, SessionSummary, TurnStats,
} from '@ruobai/chat-protocol'
import type {
  GitBranch, GitChange, GitCommitDetail, GitCommitResult, GitDiffResult, GitHostInfo, GitInfo,
  GitLogResult,
} from '@ruobai/git/types'
import type { TrajectoryFrame, TrajectorySnapshot } from '@ruobai/trajectory/types'

export type PermissionMode = 'read-only' | 'workspace-write' | 'full-access' | 'auto-review'

export type ThemePreference = 'system' | 'light' | 'dark'

/** Extra slash-command trigger configured in settings. */
export type CommandPrefix = '～' | '！' | '#'

export interface ModelProvider {
  id: string
  name: string
  /** Configured models with their display metadata. */
  models: ProviderModel[]
  note?: string
}

export interface WorkspaceMatch {
  name: string
  path: string
  type: 'file' | 'directory'
}

export interface WorkspaceTextMatch {
  path: string
  line: number
  text: string
}

/** Skill discovered from .ruobai / .claude / .agents skill roots. */
export interface SkillSummary {
  name: string
  description: string
  source: 'project' | 'global'
  root: string
  path: string
  bundle: boolean
  userInvocable: boolean
  modelInvocable: boolean
}

export interface SkillRoot {
  path: string
  source: 'project' | 'global'
}

export interface WikiSource {
  kind: 'file' | 'session' | 'url'
  path?: string
  hash?: string
  session?: string
  seq?: number[]
}

export interface WikiPageMeta {
  id: string
  title: string
  tags: string[]
  sources: WikiSource[]
  confidence?: 'high' | 'medium' | 'low'
  status: string
  revision: number
  updated?: string
}

export interface WikiPageSummary {
  id: string
  title: string
  tags?: string[]
  status: string
  confidence?: 'high' | 'medium' | 'low'
  sourced?: boolean
  summary?: string
  updated?: string
}

export interface WikiProposalDetail {
  id: string
  path: string
  meta: WikiPageMeta
  body: string
  existing: { meta: WikiPageMeta; body: string } | null
  diff: string
}

export interface WikiLintFinding {
  page?: string
  kind: string
  detail: string
}

export interface WikiCatalogEntry {
  id: string
  title: string
}

export interface WikiCatalogGroup {
  name: string
  entries: WikiCatalogEntry[]
}

export interface WikiAutomation {
  recall: boolean
  distill: boolean
}

export interface WikiSearchHit {
  page: string
  title: string
  heading: string
  summary?: string
  snippet?: string
}

export interface SkillHubSkill {
  slug: string
  name: string
  description?: string
  description_zh?: string
  iconUrl?: string | null
  category?: string
  source?: string
  version?: string
  downloads?: number
  installs?: number
  stars?: number
  namespace?: { canonicalName: string; displayName: string; publicSlug: string }
  publisher?: { name: string; verified?: boolean }
  labels?: Record<string, string>
}

export interface SkillHubCategory {
  key: string
  name: string
  active?: boolean
  sortOrder?: number
}

export interface SkillHubPage {
  skills: SkillHubSkill[]
  total: number
}

export interface ProtocolsInfo {
  instructions?: {
    root: string
    files: Array<{ path: string; display: string; bytes: number }>
    truncated: boolean
  }
  skills?: { items: SkillSummary[]; roots: SkillRoot[] }
  mcp?: { files: Array<{ path: string; label: string; count: number }> }
  a2a?: {
    sources: string[]
    agents: Array<{
      id: string
      name: string
      url: string
      tool: string
      status: 'ok' | 'error' | 'disabled'
      error?: string
      skills: Array<{ id: string; name: string; description?: string }>
    }>
  }
}

export interface RuntimeInfo {
  plugins: Array<{
    uid: number | null
    id: string
    name: string
    title?: string
    description?: string
    state: string
    services: string[]
    /** Loader row behind this plugin; required to toggle it. */
    entryId?: string
    enabled: boolean
    toggleable?: boolean
  }>
  services: string[]
  url: string
}

export interface WorkspaceEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: WorkspaceEntry[]
}

export interface WorkspaceBrowse {
  path: string
  parent: string | null
  home: string
  entries: Array<{ name: string; path: string }>
}

export type ModelInput = 'text' | 'image'

export interface ProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  inputTypes?: ModelInput[]
}

export type ProviderMode = 'direct' | 'mapping'

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

/** One environment (customer / staging / prod); secrets stay behind keyRef. */
export interface ProfileSummary {
  id: string
  label: string
  llm?: { provider?: string; baseUrl?: string; keyRef?: string }
  workspace?: { root?: string }
}

export interface PublicSettings {
  llm?: {
    activeProvider?: string
    activeModel?: string
    providers: PublicProvider[]
  }
  ui?: {
    theme?: 'light' | 'dark'
  }
  agent?: {
    defaultMode?: string
    defaultPermission?: PermissionMode
    commandPrefix?: CommandPrefix
    compactPercent?: number
    bypassApprovals?: boolean
    compactAt?: number
  }
  approval?: {
    rules: ApprovalRule[]
    guard: ApprovalGuard
  }
  profiles?: ProfileSummary[]
  activeProfile?: string
}

export interface ProviderPreset {
  id: string
  name: string
  note?: string
  website?: string
  baseUrl: string
  models: Array<{ id: string; inputTypes?: Array<'text' | 'image'> }>
}

export interface ProviderInput {
  name?: string
  note?: string
  website?: string
  baseUrl?: string
  apiKey?: string
  mode?: ProviderMode
  models?: Array<ProviderModel | string>
}

export interface SettingsPatch {
  llm?: {
    activeProvider?: string
    activeModel?: string
  }
  ui?: {
    theme?: 'light' | 'dark'
  }
  agent?: {
    defaultMode?: string
    defaultPermission?: PermissionMode
    commandPrefix?: CommandPrefix
    compactPercent?: number
    bypassApprovals?: boolean
    compactAt?: number
  }
  profiles?: ProfileSummary[]
  activeProfile?: string
}

export interface ModeInfo {
  id: string
  name: string
  description?: string
  order?: number
  autonomous?: boolean
}

export type ApprovalDecision = 'allow' | 'always' | 'deny'

export type ApprovalMatch = 'exact' | 'prefix' | 'glob' | 'contains'

export type ApprovalAction = 'allow' | 'ask' | 'deny'

export interface ApprovalRule {
  id: string
  tool: string
  match: ApprovalMatch
  pattern: string
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
  enabled?: boolean
}

export interface DangerRuleInfo {
  id: string
  label: string
  sample: string
}

export type McpApproval = 'auto' | 'always' | 'never'
export type McpStatus = 'connecting' | 'connected' | 'error' | 'disconnected'

export interface McpServer {
  id: string
  label?: string
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
  approval: McpApproval
  disabled?: boolean
  restart?: boolean
  envKeys: string[]
  hasEnv: boolean
  status: McpStatus
  error?: string
  tools: string[]
  pid?: number
}

export interface McpServerInput {
  label?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  approval?: McpApproval
  disabled?: boolean
  restart?: boolean
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  tool: string
  args: unknown
  subject?: { kind: 'command' | 'path'; value: string }
  guard?: string
  summary: string
  diff?: string
  createdAt: number
}

export interface CheckpointChange {
  seq: number
  path: string
  tool: string
  beforeExisted: boolean
  beforeBytes?: number
  afterBytes?: number
  at?: number
  /** Unified diff captured at write time, when it was small enough. */
  diff?: string
}

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  pid?: number
  alive: boolean
  cols: number
  rows: number
  createdAt: number
  exitCode?: number | null
}

export type TerminalEvent =
  | { kind: 'output'; id: string; data: string }
  | { kind: 'exit'; id: string; code: number | null }
  | { kind: 'changed'; terminals: TerminalInfo[] }

export type PreviewStatus = 'stopped' | 'starting' | 'running' | 'failed'

export interface PreviewConfiguration {
  name: string
  runtimeExecutable: string
  runtimeArgs?: string[]
  port?: number
  url?: string
  cwd?: string
}

export interface PreviewState {
  name: string
  status: PreviewStatus
  pid?: number
  url?: string
  port?: number
  startedAt?: number
  exitCode?: number | null
  error?: string
}

export interface PreviewSnapshot {
  path: string
  /** Workspace the launch file was read from. */
  root: string
  configurations: PreviewConfiguration[]
  states: PreviewState[]
  error?: string
}

export type PreviewEvent =
  | { kind: 'state'; state: PreviewState }
  | { kind: 'log'; name: string; line: string }

/** Live view of the page the agent is driving (`browser-preview` screencast). */
export interface BrowserCastEvent {
  kind: 'open' | 'frame' | 'close'
  sessionId: string
  url: string
  title?: string
  width?: number
  height?: number
  /** Base64 JPEG for `frame`. */
  data?: string
  /** The panel opens itself when a page is first created. */
  fresh?: boolean
}

export interface ContextInfo {
  estimatedTokens: number
  compactAt: number
  summaries: number
  /** Configured model context window, when provider settings define one. */
  contextWindow?: number
  breakdown: {
    messages: number
    systemPrompt: number
    systemTools: number
    mcpTools: number
  }
  mcpTools: string[]
  /** Names of the built-in (non-MCP) tools exposed to the model. */
  systemTools: string[]
  /** Estimated/actual ratio learned from provider usage; 1 means uncalibrated. */
  calibration: number
  /** Tool results pruned from the model view. */
  prunedToolResults: number
  /** Details of the most recent pruned tool results. */
  pruned: Array<{ seq: number; name: string; before: number; after: number; text?: string }>
  /** Rolling memory checkpoint used to skip a summarization call. */
  memory?: { at: number; upToSeq: number; chars: number }
  /** Long-term memory state, when the plugin is mounted. */
  longMemory?: {
    items: number
    dormant: number
    global: number
    project: number
    injectedChars: number
    budgetTokens: number
    revision: string
    dropped: number
  }
  /** Wiki catalog state, when the plugin is mounted. */
  wiki?: {
    pages: number
    chunks: number
    ready: number
    unready: number
    catalogChars: number
    revision: string
  }
  /** Latest committed pruning epoch. */
  prune?: {
    upToSeq: number
    at: number
    reason: 'pressure' | 'manual'
    freedChars: number
    invalidatedChars: number
  }
  /** Most recent prefix break, with the reason it happened. */
  cache?: {
    at: number
    divergence: {
      region: 'tools' | 'system' | 'messages'
      index?: number
      /** Section id when a registered prompt section broke the prefix. */
      section?: string
      reason: 'mode' | 'compaction' | 'prune' | 'tools' | 'system' | 'memory' | 'messages'
      invalidatedChars: number
    }
  }
  compaction: {
    failures: number
    disabled: boolean
    lastError?: string
    lastAt?: number
    lastBefore?: number
    lastAfter?: number
  }
}

export interface TrajectoryPart {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  callId?: string
  content?: string
  isError?: boolean
}

export interface TrajectoryEvent {
  seq: number
  ts: number
  type: string
  data?: {
    id?: string
    text?: string
    at?: number
    name?: string
    callId?: string
    content?: string
    chars?: number
    isError?: boolean
    parts?: TrajectoryPart[]
    attachments?: Array<{
      id?: string
      name?: string
      kind?: string
      mime?: string
      size?: number
      path?: string
    }>
    before?: number
    after?: number
    upToSeq?: number
    trigger?: string
    message?: string
    kind?: string
    steps?: number
    source?: { kind?: string; name?: string }
    // context/snapshot: what the turn's first request was assembled from.
    workspace?: string
    provider?: string
    model?: string
    mode?: string
    permission?: string
    messages?: number
    tools?: number
    turns?: number
    systemChars?: number
    estimatedTokens?: number
    summaryUpToSeq?: number
    memoryUpToSeq?: number
    focus?: string
    [key: string]: unknown
  }
}

export interface EditorChoice {
  id: string
  name: string
  kind: 'editor' | 'folder'
}

export interface CompactionResult {
  compacted: boolean
  info?: {
    sessionId: string
    upToSeq: number
    before: number
    after: number
    trigger: string
    summaryTokens: number
  }
}

export type { TrajectoryFrame, TrajectorySnapshot }

/** One day of user activity, used by the empty-session contribution graph. */
export interface ActivityDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  count: number
}

export interface ActivitySummary {
  days: ActivityDay[]
  total: number
  max: number
  start: string
  end: string
}

export type {
  GitBranch, GitChange, GitCommit, GitCommitDetail, GitCommitFile, GitCommitResult, GitDiffResult,
  GitHostInfo, GitHostStatus, GitInfo, GitLogResult, GitRemote,
} from '@ruobai/git/types'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Contract + acceptance + verdict for the right-hand delivery panel. */
export interface DeliverySnapshot {
  sessionId: string
  rev: number
  contract: {
    id: string
    title: string
    customer: string | null
    goals: string[]
    nonGoals: string[]
    revision: number
    acceptance: Array<{ id: string; criterion: string; kind: 'auto' | 'manual' }>
  } | null
  verdict: 'pass' | 'fail' | 'unsure'
  reason: string | null
  checks: Array<{
    acceptanceId: string
    status: 'passed' | 'failed' | 'missing' | 'manual-pending'
    reason: string
    evidence: string[]
  }>
  waivers: string[]
  /** The delivery gate blocks the turn while this is true. */
  blocked: boolean
}

/** Handoff bundle manifest served by `@ruobai/handoff`. */
export interface HandoffManifest {
  generatedFrom: { sessionId: string; upToSeq: number; eventCount: number; generatedAt: string }
  artifacts: Array<{ name: string; bytes: number; sha256: string }>
}

export interface TodoSnapshot {
  sessionId: string
  rev: number
  items: TodoItem[]
}

/** A commit the host prepared; the card only has to accept or edit it. */
export interface CommitProposal {
  id: string
  sessionId: string
  workspace: string
  /** Message the card starts with. */
  message: string
  /** Alternative phrasings, offered as one-click choices. */
  candidates: string[]
  files: string[]
  /** Harness state / build output left out of this commit. */
  skipped: string[]
  stat: { add: number; del: number }
  createdAt: number
}

export type CommitEvent =
  | { kind: 'requested'; proposal: CommitProposal }
  | {
    kind: 'resolved'
    resolution: { id: string; sessionId: string; via: 'commit' | 'dismiss'; commit?: string; message?: string }
  }

/** A plan the model submitted and the user has not decided on yet. */
export interface PlanProposal {
  id: string
  sessionId: string
  title: string
  /** Markdown: goal, ordered steps, files, risks, verification. */
  plan: string
  createdAt: number
}

export type PlanAction = 'accept' | 'revise'

export type PlanEvent =
  | { kind: 'requested'; proposal: PlanProposal }
  | { kind: 'resolved'; resolution: { id: string; sessionId: string; action: PlanAction } }

export const api = {
  listTerminals: async () =>
    (await request<{ terminals: TerminalInfo[] }>('/api/terminal')).terminals,

  createTerminal: async (input: { cwd?: string; cols?: number; rows?: number } = {}) =>
    (await request<{ terminal: TerminalInfo }>('/api/terminal', {
      method: 'POST',
      body: JSON.stringify(input),
    })).terminal,

  deleteTerminal: async (id: string) =>
    request<{ ok: true }>(`/api/terminal/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  writeTerminal: async (id: string, data: string) =>
    request<{ ok: true }>(`/api/terminal/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  resizeTerminal: async (id: string, cols: number, rows: number) =>
    request<{ resized: boolean }>(`/api/terminal/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }),

  terminalBuffer: async (id: string) =>
    (await request<{ buffer: string }>(`/api/terminal/${encodeURIComponent(id)}/buffer`)).buffer,

  previewSnapshot: async (sessionId?: string) =>
    request<PreviewSnapshot>(`/api/preview${sessionQuery(sessionId)}`),

  previewAction: async (name: string, action: 'start' | 'stop' | 'restart', sessionId?: string) =>
    (await request<{ state: PreviewState }>(
      `/api/preview/${encodeURIComponent(name)}/${action}${sessionQuery(sessionId)}`,
      { method: 'POST' },
    )).state,

  previewLogs: async (name: string, sessionId?: string) =>
    request<{ state: PreviewState; logs: string[] }>(
      `/api/preview/${encodeURIComponent(name)}${sessionQuery(sessionId)}`,
    ),

  todo: async (id: string) =>
    request<TodoSnapshot>(`/api/todo?sessionId=${encodeURIComponent(id)}`),

  delivery: async (id: string) =>
    request<DeliverySnapshot>(`/api/delivery?sessionId=${encodeURIComponent(id)}`),

  handoff: async (id: string) =>
    request<HandoffManifest>(`/api/handoff/${encodeURIComponent(id)}/manifest`),

  handoffArtifact: async (id: string, name: string) => {
    const response = await fetch(`/api/handoff/${encodeURIComponent(id)}/${encodeURIComponent(name)}`)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return response.text()
  },

  getCommits: async (id: string) =>
    (await request<{ proposals: CommitProposal[] }>(
      `/api/commits?sessionId=${encodeURIComponent(id)}`,
    )).proposals,

  getPlan: async (id: string) =>
    (await request<{ plan: PlanProposal | null }>(
      `/api/plans?sessionId=${encodeURIComponent(id)}`,
    )).plan,

  resolvePlan: async (id: string, sessionId: string, action: PlanAction, feedback?: string) =>
    request<{ ok: true }>(`/api/plans/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, action, ...(feedback ? { feedback } : {}) }),
    }),

  resolveCommit: async (id: string, input: { action: 'commit' | 'dismiss'; message?: string }) =>
    (await request<{ resolution: { id: string; via: string; commit?: string } }>(
      `/api/commits/${encodeURIComponent(id)}`,
      { method: 'POST', body: JSON.stringify(input) },
    )).resolution,

  listSessions: async () =>
    (await request<{ sessions: SessionSummary[] }>('/api/sessions')).sessions,

  getSession: async (id: string) =>
    (await request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(id)}`)).session,

  createSession: async (input: { title?: string; workspace?: string; mode?: string } = {}) =>
    (await request<{ session: ChatSession }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    })).session,

  renameSession: async (id: string, title: string) =>
    (await request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })).session,

  setArchived: async (id: string, archived: boolean) =>
    (await request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    })).session,

  deleteSession: async (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  forkSession: async (id: string, upToSeq?: number) =>
    (await request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(id)}/fork`, {
      method: 'POST',
      body: JSON.stringify({ upToSeq }),
    })).session,

  sendMessage: async (id: string, text: string, attachments: AttachmentMeta[] = []) =>
    request<{ message: ChatMessage; queued?: boolean }>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify(attachments.length ? { text, attachments } : { text }),
    }),

  withdrawQueued: async (id: string, queuedId: string) =>
    request<{ queued: QueuedMessage; session: ChatSession }>(
      `/api/sessions/${encodeURIComponent(id)}/queued/${encodeURIComponent(queuedId)}`,
      { method: 'DELETE' },
    ),

  stopSession: async (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),

  getRuntime: async () => request<RuntimeInfo>('/api/runtime'),

  setPluginEnabled: async (entryId: string, enabled: boolean) =>
    request<RuntimeInfo>(`/api/plugins/${encodeURIComponent(entryId)}`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  getModes: async () =>
    request<{ modes: ModeInfo[]; default: string }>('/api/modes'),

  getModels: async () =>
    (await request<{ providers: ModelProvider[] }>('/api/models')).providers,

  setSessionModel: async (id: string, provider: string, model: string) =>
    (await request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(id)}/model`, {
      method: 'POST',
      body: JSON.stringify({ provider, model }),
    })).session,

  setSessionPermission: async (id: string, mode: PermissionMode, confirm = false) =>
    (await request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(id)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ mode, confirm }),
    })).session,

  setSessionMode: async (id: string, mode: string) =>
    (await request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(id)}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    })).session,

  getApprovals: async (sessionId?: string) =>
    (await request<{ approvals: ApprovalRequest[] }>(
      `/api/approvals${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    )).approvals,

  resolveApproval: async (id: string, decision: ApprovalDecision) =>
    request<{ ok: true }>(`/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

  getAsks: async (sessionId?: string) =>
    (await request<{ asks: AskRequest[] }>(
      `/api/asks${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    )).asks,

  answerAsk: async (id: string, answers: string[]) =>
    request<{ ok: true; via: string }>(`/api/asks/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),

  getApprovalRules: async () =>
    (await request<{ rules: ApprovalRule[] }>('/api/approval/rules')).rules,

  createApprovalRule: async (input: ApprovalRuleInput) =>
    (await request<{ rules: ApprovalRule[] }>('/api/approval/rules', {
      method: 'POST',
      body: JSON.stringify(input),
    })).rules,

  updateApprovalRule: async (id: string, input: ApprovalRuleInput) =>
    (await request<{ rules: ApprovalRule[] }>(`/api/approval/rules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })).rules,

  deleteApprovalRule: async (id: string) =>
    (await request<{ rules: ApprovalRule[] }>(`/api/approval/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })).rules,

  getApprovalGuard: async () =>
    request<{ guard: ApprovalGuard; builtin: DangerRuleInfo[] }>('/api/approval/guard'),

  updateApprovalGuard: async (input: ApprovalGuard) =>
    (await request<{ guard: ApprovalGuard }>('/api/approval/guard', {
      method: 'PATCH',
      body: JSON.stringify(input),
    })).guard,

  getContext: async (id: string) =>
    request<ContextInfo>(`/api/sessions/${encodeURIComponent(id)}/context`),

  getTrajectory: async (id: string) =>
    (await request<{ events: TrajectoryEvent[] }>(
      `/api/sessions/${encodeURIComponent(id)}/trajectory`,
    )).events,

  getTrajectorySnapshot: async (id: string, options: { tail?: number; before?: number } = {}) => {
    const query = new URLSearchParams()
    if (options.tail !== undefined) query.set('tail', String(options.tail))
    if (options.before !== undefined) query.set('before', String(options.before))
    const suffix = query.size ? `?${query.toString()}` : ''
    return (await request<{ snapshot: TrajectorySnapshot }>(
      `/api/trajectory/sessions/${encodeURIComponent(id)}${suffix}`,
    )).snapshot
  },

  compactSession: async (id: string) =>
    request<CompactionResult>(`/api/sessions/${encodeURIComponent(id)}/compact`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  getEditors: async (sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return (await request<{ editors: EditorChoice[] }>(`/api/workspace/editors${suffix}`)).editors
  },

  getCheckpoints: async (id: string) =>
    (await request<{ changes: CheckpointChange[] }>(`/api/checkpoints/${encodeURIComponent(id)}`)).changes,

  createPull: async (id: string, input: {
    title: string
    body?: string
    branch: string
    base: string
    files: string[]
  }) =>
    request<{ url: string; provider: 'github' | 'gitee'; branch: string; base: string; commit?: string }>(
      '/api/git/pr',
      { method: 'POST', body: JSON.stringify({ ...input, sessionId: id }) },
    ),

  getGitInfo: async (id: string) =>
    request<GitInfo>(`/api/git/info?sessionId=${encodeURIComponent(id)}`),

  getGitStatus: async (id: string) =>
    request<{ info: GitInfo; changes: GitChange[] }>(
      `/api/git/status?sessionId=${encodeURIComponent(id)}`,
    ),

  getGitDiff: async (
    id: string,
    options: { path: string; scope?: 'working' | 'staged' | 'commit'; hash?: string },
  ) => {
    const params = new URLSearchParams({ sessionId: id, path: options.path })
    if (options.scope) params.set('scope', options.scope)
    if (options.hash) params.set('hash', options.hash)
    return request<GitDiffResult>(`/api/git/diff?${params}`)
  },

  getGitLog: async (
    id: string,
    options: { limit?: number; skip?: number; all?: boolean; ref?: string; q?: string; path?: string } = {},
  ) => {
    const params = new URLSearchParams({ sessionId: id })
    if (options.limit) params.set('limit', String(options.limit))
    if (options.skip) params.set('skip', String(options.skip))
    if (options.all) params.set('all', '1')
    if (options.ref) params.set('ref', options.ref)
    if (options.q) params.set('q', options.q)
    if (options.path) params.set('path', options.path)
    return request<GitLogResult>(`/api/git/log?${params}`)
  },

  getGitCommit: async (id: string, hash: string) => {
    const params = new URLSearchParams({ sessionId: id, hash })
    return request<GitCommitDetail>(`/api/git/commit?${params}`)
  },

  getGitBranches: async (id: string) =>
    (await request<{ branches: GitBranch[] }>(
      `/api/git/branches?sessionId=${encodeURIComponent(id)}`,
    )).branches,

  stageGitPaths: async (id: string, paths: string[]) =>
    request<{ ok: true }>('/api/git/stage', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, paths }),
    }),

  unstageGitPaths: async (id: string, paths: string[]) =>
    request<{ ok: true }>('/api/git/unstage', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, paths }),
    }),

  discardGitPaths: async (id: string, paths: string[]) =>
    request<{ ok: true }>('/api/git/discard', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, paths }),
    }),

  commitGit: async (
    id: string,
    options: { message: string; amend?: boolean; signoff?: boolean; paths?: string[] },
  ) =>
    request<GitCommitResult>('/api/git/commit', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, ...options }),
    }),

  checkoutGitBranch: async (id: string, branch: string) =>
    (await request<{ ok: true; branch: string }>('/api/git/checkout', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, branch }),
    })).branch,

  createGitBranch: async (id: string, name: string) =>
    (await request<{ ok: true; branch: string }>('/api/git/branch', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, name }),
    })).branch,

  gitFetch: async (id: string) =>
    request<{ output: string }>('/api/git/fetch', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    }),

  gitPull: async (id: string) =>
    request<{ output: string }>('/api/git/pull', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    }),

  gitPush: async (id: string, remote?: string) =>
    request<{ output: string }>('/api/git/push', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, ...(remote ? { remote } : {}) }),
    }),

  /** Registered hosting services (Gitee, GitHub, …) with their connection state. */
  getGitHosts: async (id: string) =>
    (await request<{ hosts: GitHostInfo[] }>(
      `/api/git/hosts?sessionId=${encodeURIComponent(id)}`,
    )).hosts,

  /** A commit message proposed from the current changes. */
  getCommitSuggestion: async (id: string) =>
    request<{ message: string; candidates: string[] }>(
      `/api/git/suggestion?sessionId=${encodeURIComponent(id)}`,
    ),

  getWorkspaceTree: async (path = '.', sessionId?: string, depth?: number, compact?: boolean) => {
    const params = new URLSearchParams({ path })
    if (sessionId) params.set('sessionId', sessionId)
    if (depth) params.set('depth', String(depth))
    if (compact) params.set('compact', '1')
    return (await request<{ tree: WorkspaceEntry }>(`/api/workspace/tree?${params}`)).tree
  },

  searchWorkspace: async (query: string, sessionId?: string, limit = 20) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    if (sessionId) params.set('sessionId', sessionId)
    return (await request<{ files: WorkspaceMatch[] }>(`/api/workspace/search?${params}`)).files
  },

  searchWorkspaceContent: async (query: string, sessionId?: string, limit = 50) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    if (sessionId) params.set('sessionId', sessionId)
    return (await request<{ matches: WorkspaceTextMatch[] }>(`/api/workspace/grep?${params}`)).matches
  },

  getSkills: async (sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return (await request<{ skills: SkillSummary[] }>(`/api/skills${suffix}`)).skills
  },

  getActivity: async () => request<ActivitySummary>('/api/activity'),

  getProtocols: async (sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<ProtocolsInfo>(`/api/protocols${suffix}`)
  },
  getWikiPages: async (sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return (await request<{ pages: WikiPageSummary[] }>(`/api/wiki${suffix}`)).pages
  },

  getWikiPage: async (id: string, sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<{ meta: WikiPageMeta; body: string; stale: Array<{ path: string; reason: string }> }>(
      `/api/wiki/page/${encodeURIComponent(id)}${suffix}`,
    )
  },
  createWikiCatalogGroup: async (name: string, sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<{ catalog: WikiCatalogGroup[] }>(`/api/wiki/catalog/groups${suffix}`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },

  addWikiCatalogEntry: async (id: string, group: string | undefined, sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<{ catalog: WikiCatalogGroup[] }>(`/api/wiki/catalog/entries${suffix}`, {
      method: 'POST',
      body: JSON.stringify({ id, ...(group ? { group } : {}) }),
    })
  },

  removeWikiCatalogEntry: async (id: string, sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<{ catalog: WikiCatalogGroup[] }>(
      `/api/wiki/catalog/entries/${encodeURIComponent(id)}${suffix}`,
      { method: 'DELETE' },
    )
  },

  getWikiAutomation: async (sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<WikiAutomation>(`/api/wiki/automation${suffix}`)
  },

  updateWikiAutomation: async (patch: Partial<WikiAutomation>, sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<WikiAutomation>(`/api/wiki/automation${suffix}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  getWikiProposal: async (id: string, sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<WikiProposalDetail>(`/api/wiki/proposals/${encodeURIComponent(id)}${suffix}`)
  },

  updateWikiProposal: async (
    id: string,
    patch: { title?: string; body?: string; tags?: string[] },
    sessionId?: string,
  ) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<{ ok: true }>(`/api/wiki/proposals/${encodeURIComponent(id)}${suffix}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  },

  getWikiDiff: async (id: string, from: number, to: number, sessionId?: string) => {
    const params = new URLSearchParams({ from: String(from), to: String(to) })
    if (sessionId) params.set('sessionId', sessionId)
    return (await request<{ diff: string }>(
      `/api/wiki/page/${encodeURIComponent(id)}/diff?${params.toString()}`,
    )).diff
  },

  getSkillHubSkills: async (params: {
    page?: number
    pageSize?: number
    keyword?: string
    category?: string
    sortBy?: string
    order?: string
  } = {}) => {
    const query = new URLSearchParams()
    if (params.page) query.set('page', String(params.page))
    if (params.pageSize) query.set('pageSize', String(params.pageSize))
    if (params.keyword?.trim()) query.set('keyword', params.keyword.trim())
    if (params.category) query.set('category', params.category)
    if (params.sortBy) query.set('sortBy', params.sortBy)
    if (params.order) query.set('order', params.order)
    return request<SkillHubPage>(`/api/skillhub/skills?${query.toString()}`)
  },

  getSkillHubCategories: async () =>
    (await request<{ items: SkillHubCategory[] }>('/api/skillhub/categories')).items,

  getSkillHubShowcase: async (section: 'recommended' | 'trending' | 'new' = 'recommended') =>
    (await request<{ skills: SkillHubSkill[] }>(`/api/skillhub/showcase?section=${section}`)).skills,

  installSkillHubSkill: async (slug: string, sessionId: string) =>
    request<{ name: string; path: string }>('/api/skillhub/install', {
      method: 'POST',
      body: JSON.stringify({ slug, sessionId }),
    }),

  uninstallSkillHubSkill: async (name: string, sessionId: string) =>
    request<{ removed: string }>(
      `/api/skillhub/installed/${encodeURIComponent(name)}?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ),


  readWorkspaceFile: async (path: string, sessionId?: string) => {
    const params = new URLSearchParams({ path })
    if (sessionId) params.set('sessionId', sessionId)
    return request<{ path: string; size: number; content: string }>(`/api/workspace/file?${params}`)
  },

  openWorkspaceFile: async (path: string, sessionId?: string) =>
    request<{ ok: true; opened: string }>('/api/workspace/open', {
      method: 'POST',
      body: JSON.stringify({ path, sessionId }),
    }),

  /** Open the session workspace root (or a path) in a detected editor. */
  openWorkspace: async (sessionId: string, editor?: string, path?: string) =>
    request<{ ok: true; opened: string }>('/api/workspace/open', {
      method: 'POST',
      body: JSON.stringify({ sessionId, ...(editor ? { editor } : {}), ...(path ? { path } : {}) }),
    }),

  browseWorkspace: async (path?: string) => {
    const suffix = path ? `?path=${encodeURIComponent(path)}` : ''
    return request<WorkspaceBrowse>(`/api/workspace/browse${suffix}`)
  },

  getSettings: async () =>
    (await request<{ settings: PublicSettings }>('/api/settings')).settings,

  updateSettings: async (patch: SettingsPatch) =>
    (await request<{ settings: PublicSettings }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })).settings,

  createProvider: async (input: ProviderInput) =>
    (await request<{ settings: PublicSettings }>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    })).settings,

  updateProvider: async (id: string, input: ProviderInput) =>
    (await request<{ settings: PublicSettings }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })).settings,

  deleteProvider: async (id: string) =>
    (await request<{ settings: PublicSettings }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })).settings,

  activateProvider: async (id: string, model?: string) =>
    (await request<{ settings: PublicSettings }>(`/api/providers/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    })).settings,

  providerPresets: async () =>
    (await request<{ presets: ProviderPreset[] }>('/api/providers/presets')).presets,

  fetchProviderModels: async (input: { baseUrl: string; apiKey?: string; id?: string }) =>
    (await request<{ models: ProviderModel[] }>('/api/providers/models', {
      method: 'POST',
      body: JSON.stringify(input),
    })).models,

  getMcpServers: async () =>
    (await request<{ servers: McpServer[] }>('/api/mcp')).servers,

  createMcpServer: async (input: McpServerInput) =>
    (await request<{ servers: McpServer[] }>('/api/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(input),
    })).servers,

  updateMcpServer: async (id: string, input: McpServerInput) =>
    (await request<{ servers: McpServer[] }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })).servers,

  deleteMcpServer: async (id: string) =>
    (await request<{ servers: McpServer[] }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })).servers,

  reconnectMcpServer: async (id: string) =>
    (await request<{ server: McpServer }>(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, {
      method: 'POST',
    })).server,
}

export interface EventHandlers {
  onOpen?: () => void
  onError?: () => void
  onChat?: (event: ChatEvent) => void
  onApproval?: (payload: ApprovalEvent) => void
  onAsk?: (payload: AskEvent) => void
  onTodo?: (payload: TodoSnapshot) => void
  onCommit?: (payload: CommitEvent) => void
  onPlan?: (payload: PlanEvent) => void
  onTerminal?: (payload: TerminalEvent) => void
  onPreview?: (payload: PreviewEvent) => void
  onBrowser?: (payload: BrowserCastEvent) => void
}

export type ApprovalEvent =
  | { kind: 'requested'; request: ApprovalRequest }
  | { kind: 'resolved'; resolution: { id: string; decision: ApprovalDecision } }

export interface AskQuestion {
  question: string
  options?: string[]
  allowFreeText: boolean
}

export interface AskRequest {
  id: string
  sessionId: string
  /** First question, kept for hosts that predate `questions`. */
  question: string
  options?: string[]
  allowFreeText: boolean
  /** Every question in order; the card answers them one page at a time. */
  questions?: AskQuestion[]
  createdAt: number
  expiresAt: number
}

export type AskEvent =
  | { kind: 'requested'; request: AskRequest }
  | { kind: 'resolved'; resolution: { id: string; via: string; answer: string | null } }

/**
 * Browsers may resolve `localhost` to ::1 while the harness binds 127.0.0.1;
 * pin the loopback name used by the page so the upgrade reaches the server.
 */
function liveUrl(path: string) {
  const host = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname
  const port = location.port ? `:${location.port}` : ''
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${host}${port}${path}`
}

/**
 * Read an `ask` frame off the WebSocket downlink.
 *
 * `ask-web` fans the question out through `ui.broadcast`, so web-ws wraps it as
 * `{ type: 'ask', data: { kind, request } }` — unlike `approval`, which web-ws
 * relays with `kind`/`request` at the top level. Reading only the top level meant
 * the card never appeared over the socket (SSE worked) and the resolved branch
 * then dereferenced an undefined resolution. Both shapes are accepted, so a
 * future top-level relay keeps working.
 */
export function parseAskFrame(payload: unknown): AskEvent | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const frame = payload as { data?: unknown; kind?: string; request?: unknown; resolution?: unknown }
  const body = (frame.data ?? frame) as {
    kind?: string
    request?: unknown
    resolution?: unknown
  }
  const kind = body.kind ?? frame.kind
  const request = body.request ?? frame.request
  const resolution = body.resolution ?? frame.resolution
  if (kind === 'requested' && request) return { kind: 'requested', request: request as AskRequest }
  if (kind === 'resolved' && resolution) {
    return { kind: 'resolved', resolution: resolution as { id: string; via: string; answer: string | null } }
  }
  return undefined
}

/**
 * Live events prefer the WebSocket downlink and fall back to SSE once if the
 * upgrade fails or the socket drops.
 */
export function connectEvents(handlers: EventHandlers) {
  let closed = false
  let fellBack = false
  let socket: WebSocket | undefined
  let source: EventSource | undefined

  const openSse = () => {
    if (closed || fellBack) return
    fellBack = true
    source = new EventSource('/api/events')
    source.onopen = () => {
      document.documentElement.dataset.live = 'sse'
      handlers.onOpen?.()
    }
    source.onerror = () => handlers.onError?.()
    source.addEventListener('chat', (event) => {
      try {
        handlers.onChat?.(JSON.parse((event as MessageEvent<string>).data) as ChatEvent)
      } catch {
        // ignore malformed frames
      }
    })
    source.addEventListener('approval', (event) => {
      try {
        handlers.onApproval?.(JSON.parse((event as MessageEvent<string>).data) as ApprovalEvent)
      } catch {
        // ignore malformed frames
      }
    })
    source.addEventListener('ask', (event) => {
      try {
        handlers.onAsk?.(JSON.parse((event as MessageEvent<string>).data) as AskEvent)
      } catch {
        // ignore malformed frames
      }
    })
    source.addEventListener('todo', (event) => {
      try {
        handlers.onTodo?.(JSON.parse((event as MessageEvent<string>).data) as TodoSnapshot)
      } catch {
        // ignore malformed frames
      }
    })
    source.addEventListener('commit', (event) => {
      try {
        handlers.onCommit?.(JSON.parse((event as MessageEvent<string>).data) as CommitEvent)
      } catch {
        // ignore malformed frames
      }
    })
    source.addEventListener('plan', (event) => {
      try {
        handlers.onPlan?.(JSON.parse((event as MessageEvent<string>).data) as PlanEvent)
      } catch {
        // ignore malformed frames
      }
    })
    source.addEventListener('terminal', (event) => {
      try {
        handlers.onTerminal?.(JSON.parse((event as MessageEvent<string>).data) as TerminalEvent)
      } catch {
        // ignore malformed frames
      }
    })
    source.addEventListener('preview', (event) => {
      try {
        handlers.onPreview?.(JSON.parse((event as MessageEvent<string>).data) as PreviewEvent)
      } catch {
        // ignore malformed frames
      }
    })
    source.addEventListener('browser', (event) => {
      try {
        handlers.onBrowser?.(JSON.parse((event as MessageEvent<string>).data) as BrowserCastEvent)
      } catch {
        // ignore malformed frames
      }
    })
  }

  try {
    socket = new WebSocket(liveUrl('/api/ws'))
    socket.onmessage = (message) => {
      if (closed) return
      try {
        const payload = JSON.parse(message.data) as {
          type: string
          event?: ChatEvent
          data?: unknown
          kind?: 'requested' | 'resolved'
          request?: ApprovalRequest | AskRequest
          resolution?:
            | { id: string; decision: ApprovalDecision }
            | { id: string; via: string; answer: string | null }
        }
        if (payload.type === 'hello') {
          document.documentElement.dataset.live = 'ws'
          handlers.onOpen?.()
        } else if (payload.type === 'todo') handlers.onTodo?.(payload.data as TodoSnapshot)
        else if (payload.type === 'commit') handlers.onCommit?.(payload.data as CommitEvent)
        else if (payload.type === 'plan') handlers.onPlan?.(payload.data as PlanEvent)
        else if (payload.type === 'terminal') handlers.onTerminal?.(payload.data as TerminalEvent)
        else if (payload.type === 'preview') handlers.onPreview?.(payload.data as PreviewEvent)
        else if (payload.type === 'browser') handlers.onBrowser?.(payload.data as BrowserCastEvent)
        else if (payload.type === 'chat' && payload.event) handlers.onChat?.(payload.event)
        else if (payload.type === 'approval') {
          handlers.onApproval?.(payload.kind === 'requested'
            ? { kind: 'requested', request: payload.request as ApprovalRequest }
            : { kind: 'resolved', resolution: payload.resolution as { id: string; decision: ApprovalDecision } })
        } else if (payload.type === 'ask') {
          const ask = parseAskFrame(payload)
          if (ask) handlers.onAsk?.(ask)
        }
      } catch {
        // ignore malformed frames
      }
    }
    socket.onerror = () => socket?.close()
    socket.onclose = () => {
      if (closed) return
      handlers.onError?.()
      openSse()
    }
  } catch {
    openSse()
  }

  return {
    close: () => {
      closed = true
      // StrictMode unmounts while the socket is still connecting; closing it
      // after the handshake avoids the browser's pre-open close warning.
      if (socket?.readyState === WebSocket.CONNECTING) {
        socket.addEventListener('open', () => socket?.close(), { once: true })
      } else {
        socket?.close()
      }
      source?.close()
    },
  }
}

function sessionQuery(sessionId?: string) {
  return sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
}

export function summarize(session: ChatSession): SessionSummary {  return {
    id: session.id,
    title: session.title,
    model: session.model,
    provider: session.provider,
    mode: session.mode,
    permission: session.permission,
    workspace: session.workspace,
    archived: session.archived,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    streaming: session.streaming,
  }
}
