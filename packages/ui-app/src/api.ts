import type {
  AttachmentMeta, ChatEvent, ChatMessage, ChatSession, SessionSummary, TurnStats,
} from '@ruobai/chat-protocol'
import type {
  GitBranch, GitChange, GitCommitDetail, GitCommitResult, GitDiffResult, GitInfo, GitLogResult,
} from '@ruobai/git/types'

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
  pruned: Array<{ seq: number; name: string; before: number; after: number }>
  /** Rolling memory checkpoint used to skip a summarization call. */
  memory?: { at: number; upToSeq: number; chars: number }
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

export type {
  GitBranch, GitChange, GitCommit, GitCommitDetail, GitCommitFile, GitCommitResult, GitDiffResult,
  GitInfo, GitLogResult,
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

export const api = {
  listSessions: async () =>
    (await request<{ sessions: SessionSummary[] }>('/api/sessions')).sessions,

  getSession: async (id: string) =>
    (await request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(id)}`)).session,

  createSession: async (input: { title?: string; workspace?: string } = {}) =>
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
    (await request<{ message: ChatMessage }>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify(attachments.length ? { text, attachments } : { text }),
    })).message,

  stopSession: async (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),

  getRuntime: async () => request<RuntimeInfo>('/api/runtime'),

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

  compactSession: async (id: string) =>
    request<CompactionResult>(`/api/sessions/${encodeURIComponent(id)}/compact`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  getEditors: async (sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return (await request<{ editors: EditorChoice[] }>(`/api/workspace/editors${suffix}`)).editors
  },

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

  gitPush: async (id: string) =>
    request<{ output: string }>('/api/git/push', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    }),

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

  getProtocols: async (sessionId?: string) => {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return request<ProtocolsInfo>(`/api/protocols${suffix}`)
  },

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
}

export type ApprovalEvent =
  | { kind: 'requested'; request: ApprovalRequest }
  | { kind: 'resolved'; resolution: { id: string; decision: ApprovalDecision } }

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
  }

  try {
    socket = new WebSocket(liveUrl('/api/ws'))
    socket.onmessage = (message) => {
      if (closed) return
      try {
        const payload = JSON.parse(message.data) as {
          type: string
          event?: ChatEvent
          kind?: 'requested' | 'resolved'
          request?: ApprovalRequest
          resolution?: { id: string; decision: ApprovalDecision }
        }
        if (payload.type === 'hello') {
          document.documentElement.dataset.live = 'ws'
          handlers.onOpen?.()
        } else if (payload.type === 'chat' && payload.event) handlers.onChat?.(payload.event)
        else if (payload.type === 'approval') {
          handlers.onApproval?.(payload.kind === 'requested'
            ? { kind: 'requested', request: payload.request! }
            : { kind: 'resolved', resolution: payload.resolution! })
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

export function summarize(session: ChatSession): SessionSummary {
  return {
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
