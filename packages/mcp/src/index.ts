import { createHash } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import type { ToolDefinition } from '@ruobai/tools'
import {
  McpClient,
  type McpCallResult,
  type McpContent,
  type McpTool,
} from './protocol.ts'

export type McpApproval = 'auto' | 'always' | 'never'

export interface McpServerDefinition {
  /** Stable id used in tool names; changing it creates a different server. */
  id: string
  label?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  /**
   * auto: ask before anything not marked `readOnlyHint`.
   * always: ask for every call. never: never ask.
   */
  approval?: McpApproval
  /** Restart after an unexpected exit. Defaults to true. */
  restart?: boolean
}

export type McpStatus = 'connecting' | 'connected' | 'error' | 'disconnected'

export interface McpServerStatus {
  id: string
  label: string
  status: McpStatus
  error?: string
  /** Original tool names advertised by the server. */
  tools: string[]
  pid?: number
}

interface Normalized extends McpServerDefinition {
  label: string
  args: string[]
  timeoutMs: number
  approval: McpApproval
  restart: boolean
}

interface ServerState {
  definition: Normalized
  signature: string
  client?: McpClient
  status: McpStatus
  error?: string
  tools: string[]
  disposers: Array<() => void>
  refresh?: Promise<void>
  restartTimer?: ReturnType<typeof setTimeout>
  attempt: number
  stopping: boolean
}

declare module '@ruobai/cordis' {
  interface Context {
    mcp: McpService
  }

  interface Events {
    'mcp/changed'(): void
  }
}

/**
 * Owns MCP server connections and exposes their tools to the registry.
 *
 * One service instance can manage any number of servers. Tools are named
 * `mcp__<server>__<tool>` and removed when the server disconnects, so MCP is
 * optional at every layer: no server configured means no extra tools.
 */
export class McpService extends Service {
  static inject = ['tools']

  private readonly states = new Map<string, ServerState>()
  private disposed = false
  private readonly logger

  constructor(ctx: Context) {
    super(ctx, 'mcp')
    this.logger = ctx.logger('mcp')
    ctx.effect(() => () => {
      this.disposed = true
      for (const state of this.states.values()) {
        state.stopping = true
        if (state.restartTimer) clearTimeout(state.restartTimer)
        state.client?.close()
        this.disposeTools(state)
      }
      this.states.clear()
    }, 'mcp.dispose')
  }

  list(): McpServerStatus[] {
    return [...this.states.values()].map(state => this.statusOf(state))
  }

  get(id: string): McpServerStatus | undefined {
    const state = this.states.get(id)
    return state ? this.statusOf(state) : undefined
  }

  async connect(definition: McpServerDefinition): Promise<McpServerStatus> {
    const normalized = normalize(definition)
    if (this.states.has(normalized.id)) await this.disconnect(normalized.id)
    const state: ServerState = {
      definition: normalized,
      signature: JSON.stringify(normalized),
      status: 'connecting',
      tools: [],
      disposers: [],
      attempt: 0,
      stopping: false,
    }
    this.states.set(normalized.id, state)
    this.emit()
    await this.launch(state)
    return this.statusOf(state)
  }

  async disconnect(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state) return
    state.stopping = true
    if (state.restartTimer) {
      clearTimeout(state.restartTimer)
      state.restartTimer = undefined
    }
    this.states.delete(id)
    state.client?.close()
    state.client = undefined
    this.disposeTools(state)
    state.tools = []
    this.emit()
  }

  async reconnect(id: string): Promise<McpServerStatus> {
    const state = this.states.get(id)
    if (!state) throw new Error(`unknown MCP server: ${id}`)
    if (state.restartTimer) {
      clearTimeout(state.restartTimer)
      state.restartTimer = undefined
    }
    state.stopping = true
    state.client?.close()
    state.client = undefined
    this.disposeTools(state)
    state.tools = []
    state.stopping = false
    state.attempt = 0
    await this.launch(state)
    return this.statusOf(state)
  }

  /** Reconcile the running set with a desired list (settings are the source). */
  async sync(definitions: McpServerDefinition[]): Promise<void> {
    const wanted = new Map<string, McpServerDefinition>()
    for (const definition of definitions) {
      try {
        wanted.set(normalize(definition).id, definition)
      } catch (error) {
        this.logger.warn(error)
      }
    }

    for (const [id, state] of [...this.states]) {
      const definition = wanted.get(id)
      if (!definition) {
        await this.disconnect(id)
        continue
      }
      const signature = JSON.stringify(normalize(definition))
      if (signature !== state.signature) await this.disconnect(id)
    }

    const started: Array<Promise<unknown>> = []
    for (const [id, definition] of wanted) {
      if (this.states.has(id)) continue
      started.push(this.connect(definition))
    }
    await Promise.allSettled(started)
  }

  private async launch(state: ServerState) {
    if (this.disposed || state.stopping || this.states.get(state.definition.id) !== state) return
    state.status = 'connecting'
    state.error = undefined
    this.emit()

    const client = new McpClient({
      id: state.definition.id,
      command: state.definition.command,
      args: state.definition.args,
      env: state.definition.env,
      cwd: state.definition.cwd,
      timeoutMs: state.definition.timeoutMs,
      logger: (level, message) => this.logger[level](message),
      onToolsChanged: () => void this.refreshTools(state),
      onClose: error => this.onClose(state, error),
    })
    state.client = client

    try {
      await client.start()
      await this.refreshTools(state)
      if (state.stopping || this.states.get(state.definition.id) !== state) return
      state.status = 'connected'
      state.attempt = 0
      state.error = undefined
    } catch (error) {
      state.error = messageOf(error)
      state.status = 'error'
      state.client = undefined
      this.disposeTools(state)
      state.tools = []
      client.close()
      this.retry(state)
    }
    this.emit()
  }

  private refreshTools(state: ServerState): Promise<void> {
    state.refresh = (state.refresh ?? Promise.resolve())
      .then(async () => {
        const client = state.client
        if (!client || state.stopping) return
        const tools = await client.listTools()
        if (state.client !== client) return
        this.applyTools(state, tools)
        this.emit()
      })
      .catch((error) => {
        this.logger.warn(error)
        if (state.status === 'connected') state.error = messageOf(error)
      })
    return state.refresh
  }

  private applyTools(state: ServerState, tools: McpTool[]) {
    this.disposeTools(state)
    const disposers: Array<() => void> = []
    for (const tool of tools) {
      if (!tool?.name) continue
      const name = toolName(state.definition.id, tool.name)
      const definition = this.toolDefinition(state, tool, name)
      try {
        disposers.push(this.ctx.tools.register(definition))
      } catch (error) {
        this.logger.warn(`cannot register ${name}: ${messageOf(error)}`)
      }
    }
    state.disposers = disposers
    state.tools = tools.map(tool => tool.name).filter(Boolean)
  }

  private toolDefinition(state: ServerState, tool: McpTool, name: string): ToolDefinition {
    const server = state.definition
    const approval = server.approval === 'always'
      ? true
      : server.approval === 'never'
        ? false
        : tool.annotations?.readOnlyHint !== true

    return {
      name,
      description: `[${server.label}] ${tool.description?.trim() || tool.name}`.slice(0, 2_000),
      parameters: isSchema(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
      requiresApproval: approval,
      readOnly: tool.annotations?.readOnlyHint === true,
      preview(args) {
        return {
          summary: `${server.label} · ${tool.name}`,
          diff: previewArgs(args),
        }
      },
      execute: async (args, run) => this.callTool(state, tool.name, args, run.signal),
    }
  }

  private async callTool(state: ServerState, tool: string, args: unknown, signal?: AbortSignal) {
    const client = state.client
    if (!client || state.status !== 'connected') {
      throw new Error(`MCP server "${state.definition.id}" is not connected`)
    }
    const result = await client.callTool(tool, args ?? {}, { signal })
    const text = renderResult(result)
    if (result.isError) throw new Error(text || `MCP tool "${tool}" failed`)
    return text || '(no output)'
  }

  private onClose(state: ServerState, error: Error) {
    if (this.disposed || state.stopping || this.states.get(state.definition.id) !== state) return
    state.client = undefined
    this.disposeTools(state)
    state.tools = []
    state.status = 'error'
    state.error = error.message
    this.logger.warn(error)
    this.emit()
    this.retry(state)
  }

  private retry(state: ServerState) {
    if (!state.definition.restart || this.disposed || state.stopping) return
    if (state.restartTimer) return
    const delay = Math.min(30_000, 1_000 * 2 ** state.attempt)
    state.attempt = Math.min(state.attempt + 1, 5)
    state.restartTimer = setTimeout(() => {
      state.restartTimer = undefined
      void this.launch(state)
    }, delay)
    state.restartTimer.unref?.()
  }

  private disposeTools(state: ServerState) {
    for (const dispose of state.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // already disposed
      }
    }
  }

  private statusOf(state: ServerState): McpServerStatus {
    return {
      id: state.definition.id,
      label: state.definition.label,
      status: state.status,
      error: state.error,
      tools: [...state.tools],
      pid: state.client?.pid,
    }
  }

  private emit() {
    this.ctx.emit('mcp/changed')
  }
}

export default McpService

function normalize(definition: McpServerDefinition): Normalized {
  const id = String(definition?.id ?? '').trim()
  if (!id) throw new Error('MCP server id is required')
  if (id.length > 48) throw new Error('MCP server id is too long')
  const command = String(definition?.command ?? '').trim()
  if (!command) throw new Error(`MCP server "${id}" needs a command`)
  const args = (definition.args ?? []).map(String).filter(Boolean)
  if (args.length > 64) throw new Error(`MCP server "${id}" has too many arguments`)
  const timeoutMs = clamp(Number(definition.timeoutMs) || 60_000, 100, 600_000)
  const approval = definition.approval === 'always' || definition.approval === 'never'
    ? definition.approval
    : 'auto'
  return {
    ...definition,
    id,
    label: definition.label?.trim() || id,
    command,
    args,
    timeoutMs,
    approval,
    restart: definition.restart !== false,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function toolName(serverId: string, tool: string) {
  const raw = `mcp__${serverId}__${tool}`
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  if (clean.length <= 64) return clean
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 6)
  return `${clean.slice(0, 57)}-${hash}`
}

function isSchema(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function previewArgs(args: unknown) {
  let text: string
  try {
    text = JSON.stringify(args ?? {}, null, 2)
  } catch {
    text = String(args)
  }
  if (!text) return '{}'
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text
}

function renderResult(result: McpCallResult) {
  const parts: string[] = []
  for (const item of result.content ?? []) {
    parts.push(renderContent(item))
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2))
  }
  return parts.filter(Boolean).join('\n\n')
}

function renderContent(item: McpContent) {
  if (item.type === 'text') return item.text ?? ''
  if (item.type === 'image') return `[image ${item.mimeType ?? 'unknown'}, ${item.data?.length ?? 0} base64 chars]`
  if (item.type === 'audio') return `[audio ${item.mimeType ?? 'unknown'}]`
  if (item.type === 'resource') {
    const resource = item.resource
    if (resource?.text !== undefined) return resource.text
    if (resource?.uri) return `[resource ${resource.uri}]`
    return '[resource]'
  }
  return `[${item.type}]`
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
