import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: McpToolAnnotations
}

export interface McpContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string }
}

export interface McpCallResult {
  content?: McpContent[]
  structuredContent?: unknown
  isError?: boolean
}

export interface McpServerInfo {
  name?: string
  version?: string
}

export interface McpInitializeResult {
  protocolVersion?: string
  capabilities?: Record<string, unknown>
  serverInfo?: McpServerInfo
}

export interface McpClientOptions {
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Applied to every request unless the caller overrides it. */
  timeoutMs?: number
  logger?(level: 'debug' | 'warn' | 'error', message: string): void
  /** A server announced `notifications/tools/list_changed`. */
  onToolsChanged?(): void
  /** The process died unexpectedly (not via `close()`). */
  onClose?(error: Error): void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

const PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_TIMEOUT = 60_000

/**
 * Minimal MCP client over the stdio transport.
 *
 * Framing is newline-delimited JSON-RPC 2.0 as specified for stdio; the
 * client only needs `initialize`, `tools/list` and `tools/call`, so it does
 * not depend on an SDK. Server-initiated requests we do not implement are
 * answered with `-32601` instead of being left hanging.
 */
export class McpClient {
  private child?: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private closed = false

  serverInfo?: McpServerInfo
  capabilities?: Record<string, unknown>
  protocolVersion?: string

  constructor(private readonly options: McpClientOptions) {}

  get pid() {
    return this.child?.pid
  }

  get isClosed() {
    return this.closed
  }

  async start(): Promise<McpInitializeResult> {
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd ? resolve(this.options.cwd) : undefined,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so a misbehaving server and its children can be stopped.
      detached: true,
      windowsHide: true,
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk))
    child.stdin?.on('error', error => this.log('warn', `stdin: ${error.message}`))

    child.on('error', (error) => {
      if (this.closed) return
      this.finish(new Error(`MCP server failed to start: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      if (this.closed) return
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'none'}`
      this.finish(new Error(`MCP server exited (${detail})`))
    })

    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ruobai-harness', version: '0.0.1' },
    }) as McpInitializeResult

    this.protocolVersion = result?.protocolVersion
    this.capabilities = result?.capabilities
    this.serverInfo = result?.serverInfo
    this.notify('notifications/initialized')
    return result
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    // Bound pagination so a broken server cannot keep us in a loop.
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}) as {
        tools?: McpTool[]
        nextCursor?: string
      }
      if (Array.isArray(result?.tools)) tools.push(...result.tools)
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: unknown, options: RequestOptions = {}): Promise<McpCallResult> {
    return await this.request('tools/call', { name, arguments: args ?? {} }, options) as McpCallResult
  }

  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed || !this.child) return Promise.reject(new Error('MCP connection is closed'))
    const id = this.nextId++
    const timeout = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        const entry = this.pending.get(id)
        this.pending.delete(id)
        entry?.cleanup()
        action()
      }

      const timer = setTimeout(() => {
        finish(() => rejectPromise(new Error(`${method} timed out after ${timeout}ms`)))
      }, timeout)

      const onAbort = () => {
        this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled' })
        finish(() => rejectPromise(new Error('cancelled')))
      }

      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }

      this.pending.set(id, {
        resolve: value => finish(() => resolvePromise(value)),
        reject: error => finish(() => rejectPromise(error)),
        cleanup,
      })

      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      if (!this.send({ jsonrpc: '2.0', id, method, params })) {
        finish(() => rejectPromise(new Error('failed to write to the MCP server')))
      }
    })
  }

  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  close() {
    if (this.closed) return
    this.closed = true
    const error = new Error('MCP connection closed')
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.cleanup()
      entry.reject(error)
    }
    const child = this.child
    if (!child?.pid) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }, 1_000)
    timer.unref?.()
  }

  private finish(error: Error) {
    this.closed = true
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.cleanup()
      entry.reject(error)
    }
    this.options.onClose?.(error)
  }

  private send(message: unknown): boolean {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return false
    try {
      stdin.write(JSON.stringify(message) + '\n')
      return true
    } catch {
      return false
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '').trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        this.log('warn', `ignored non-JSON output: ${line.slice(0, 200)}`)
        continue
      }
      this.handle(message)
    }
  }

  private onStderr(chunk: string) {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) this.log('debug', line.trim())
    }
  }

  private handle(message: any) {
    if (!message || message.jsonrpc !== '2.0') return

    if (typeof message.method === 'string') {
      if (message.id === undefined) this.onNotification(message)
      else this.onServerRequest(message)
      return
    }

    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    entry.cleanup()
    if (message.error) {
      entry.reject(new Error(message.error.message ?? `MCP error ${message.error.code}`))
    } else {
      entry.resolve(message.result)
    }
  }

  private onNotification(message: any) {
    if (message.method === 'notifications/tools/list_changed') this.options.onToolsChanged?.()
    else if (message.method === 'notifications/message') {
      const text = message.params?.data
      this.log('debug', typeof text === 'string' ? text : JSON.stringify(text))
    }
  }

  private onServerRequest(message: any) {
    if (message.method === 'ping') {
      this.send({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }
    this.send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `method not supported: ${message.method}` },
    })
  }

  private log(level: 'debug' | 'warn' | 'error', message: string) {
    this.options.logger?.(level, `[${this.options.id}] ${message}`)
  }
}
