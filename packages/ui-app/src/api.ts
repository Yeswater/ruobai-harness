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

  createSession: async (title?: string) =>
    (await request<{ session: ChatSession }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    })).session,

  sendMessage: async (id: string, text: string) =>
    (await request<{ message: ChatMessage }>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })).message,

  stopSession: async (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),

  getRuntime: async () => request<RuntimeInfo>('/api/runtime'),

  getWorkspaceTree: async (path = '.') =>
    (await request<{ tree: WorkspaceEntry }>(`/api/workspace/tree?path=${encodeURIComponent(path)}`)).tree,

  readWorkspaceFile: async (path: string) =>
    request<{ path: string; size: number; content: string }>(
      `/api/workspace/file?path=${encodeURIComponent(path)}`,
    ),

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
}

export interface EventHandlers {
  onOpen?: () => void
  onError?: () => void
  onChat?: (event: ChatEvent) => void
}

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
  }

  try {
    socket = new WebSocket(liveUrl('/api/ws'))
    socket.onmessage = (message) => {
      if (closed) return
      try {
        const payload = JSON.parse(message.data) as { type: string; event?: ChatEvent }
        if (payload.type === 'hello') {
          document.documentElement.dataset.live = 'ws'
          handlers.onOpen?.()
        } else if (payload.type === 'chat' && payload.event) handlers.onChat?.(payload.event)
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
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    streaming: session.streaming,
  }
}
