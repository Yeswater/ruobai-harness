import type { ChatEvent, ChatMessage, ChatSession, SessionSummary } from '@ruobai/chat-protocol'

export interface RuntimeInfo {
  plugins: Array<{ uid: number | null; name: string; state: string; services: string[] }>
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

export interface ProviderModel {
  id: string
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

export interface SessionChange {
  seq: number
  path: string
  tool: string
  callId?: string
  beforeHash?: string
  afterHash?: string
  beforeBytes?: number
  afterBytes?: number
  beforeExisted: boolean
  skipped?: 'too-large' | 'unreadable'
  diff?: string
  at: number
}

export interface RevertResult {
  reverted: string[]
  skipped: Array<{ path: string; reason: string }>
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
  breakdown: {
    messages: number
    systemPrompt: number
    systemTools: number
    mcpTools: number
  }
  mcpTools: string[]
}

export interface GitInfo {
  available: boolean
  branch: string | null
  workspace: string
  home: string
  files: number
  added: number
  removed: number
}

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

  sendMessage: async (id: string, text: string) =>
    (await request<{ message: ChatMessage }>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })).message,

  stopSession: async (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),

  getRuntime: async () => request<RuntimeInfo>('/api/runtime'),

  getModes: async () =>
    request<{ modes: ModeInfo[]; default: string }>('/api/modes'),

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

  getSessionChanges: async (id: string) =>
    (await request<{ changes: SessionChange[] }>(`/api/checkpoints/${encodeURIComponent(id)}`)).changes,

  revertSessionChanges: async (id: string, upToSeq?: number) =>
    request<RevertResult>(`/api/checkpoints/${encodeURIComponent(id)}/revert`, {
      method: 'POST',
      body: JSON.stringify(upToSeq === undefined ? {} : { upToSeq }),
    }),

  getContext: async (id: string) =>
    request<ContextInfo>(`/api/sessions/${encodeURIComponent(id)}/context`),

  getGitInfo: async (id: string) =>
    request<GitInfo>(`/api/workspace/git?sessionId=${encodeURIComponent(id)}`),

  commitWorkspace: async (id: string, message: string) =>
    request<{ ok: true; commit: string }>('/api/workspace/commit', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, message }),
    }),

  getWorkspaceTree: async (path = '.', sessionId?: string, depth?: number) => {
    const params = new URLSearchParams({ path })
    if (sessionId) params.set('sessionId', sessionId)
    if (depth) params.set('depth', String(depth))
    return (await request<{ tree: WorkspaceEntry }>(`/api/workspace/tree?${params}`)).tree
  },

  readWorkspaceFile: async (path: string, sessionId?: string) => {
    const params = new URLSearchParams({ path })
    if (sessionId) params.set('sessionId', sessionId)
    return request<{ path: string; size: number; content: string }>(`/api/workspace/file?${params}`)
  },

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
    mode: session.mode,
    workspace: session.workspace,
    archived: session.archived,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    streaming: session.streaming,
  }
}
