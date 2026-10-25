import { randomUUID } from 'node:crypto'
import { assertSafeUrl, readCapped, type A2aCard } from './card.ts'

export interface A2aCallOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  allowPrivateHosts?: boolean
  skill?: string
  contextId?: string
  pollIntervalMs?: number
  maxPollMs?: number
  fetch?: typeof fetch
}

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'cancelled', 'rejected'])

/** Sends one prompt to a remote agent and returns its textual reply. */
export async function sendAgentMessage(
  card: A2aCard,
  prompt: string,
  options: A2aCallOptions = {},
): Promise<string> {
  const message = {
    kind: 'message',
    role: 'user',
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: prompt }],
    ...(options.contextId ? { contextId: options.contextId } : {}),
    ...(options.skill ? { metadata: { skill: options.skill } } : {}),
  }

  let result: unknown
  try {
    result = await rpc(card.rpcUrl, 'message/send', { message }, options)
  } catch (error) {
    if (!(error instanceof RpcError) || error.code !== -32601) throw error
    // Older A2A servers use tasks/send with a top-level task id.
    result = await rpc(card.rpcUrl, 'tasks/send', { id: message.messageId, message }, options)
  }

  const task = asTask(result)
  if (!task) return textOfResult(result)
  if (TERMINAL.has(task.state)) {
    if (task.state !== 'completed') throw new Error(`agent task ${task.state}`)
    return textOfTask(result)
  }
  return pollTask(card.rpcUrl, task.id, options)
}

async function pollTask(url: string, id: string, options: A2aCallOptions) {
  const interval = options.pollIntervalMs ?? 500
  const deadline = Date.now() + (options.maxPollMs ?? 120_000)
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      await cancelTask(url, id, options).catch(() => undefined)
      throw new DOMException('aborted', 'AbortError')
    }
    await sleep(interval, options.signal)
    const result = await rpc(url, 'tasks/get', { id }, options)
    const task = asTask(result)
    if (!task) return textOfResult(result)
    if (TERMINAL.has(task.state)) {
      if (task.state !== 'completed') throw new Error(`agent task ${task.state}`)
      return textOfTask(result)
    }
  }
  throw new Error('agent task timed out')
}

export async function cancelTask(url: string, id: string, options: A2aCallOptions = {}) {
  return rpc(url, 'tasks/cancel', { id }, { ...options, timeoutMs: options.timeoutMs ?? 5_000 })
}

async function rpc(url: string, method: string, params: unknown, options: A2aCallOptions) {
  const target = new URL(url)
  assertSafeUrl(target, options.allowPrivateHosts === true)
  const timeoutMs = options.timeoutMs ?? 15_000
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (options.signal) signals.push(options.signal)
  const doFetch = options.fetch ?? fetch
  const response = await doFetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await readCapped(response, 1_048_576)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('invalid JSON-RPC response')
  }
  const record = payload as { result?: unknown; error?: { code?: number; message?: string } }
  if (record.error) {
    throw new RpcError(record.error.code ?? -1, record.error.message ?? 'remote error')
  }
  return record.result
}

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message)
    this.name = 'RpcError'
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
}

function asTask(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== 'task' && !record.status) return undefined
  const status = record.status && typeof record.status === 'object'
    ? record.status as Record<string, unknown>
    : undefined
  const state = typeof status?.state === 'string' ? status.state : typeof record.state === 'string' ? record.state : ''
  const id = typeof record.id === 'string' ? record.id : ''
  if (!state || !id) return undefined
  return { id, state }
}

function textOfResult(value: unknown) {
  const parts = collectParts(value)
  return parts.length ? parts.join('\n') : JSON.stringify(value ?? '').slice(0, 4_000)
}

function textOfTask(value: unknown) {
  const parts = collectParts(value)
  return parts.length ? parts.join('\n') : JSON.stringify(value ?? '').slice(0, 4_000)
}

function collectParts(value: unknown): string[] {
  const texts: string[] = []
  const pushParts = (parts: unknown) => {
    if (!Array.isArray(parts)) return
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const record = part as Record<string, unknown>
      if ((record.kind === 'text' || record.type === 'text') && typeof record.text === 'string') {
        texts.push(record.text)
      }
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    pushParts(record.parts)
    if (Array.isArray(record.artifacts)) {
      for (const artifact of record.artifacts) {
        if (artifact && typeof artifact === 'object') {
          pushParts((artifact as Record<string, unknown>).parts)
        }
      }
    }
    const status = record.status && typeof record.status === 'object'
      ? record.status as Record<string, unknown>
      : undefined
    if (status?.message && typeof status.message === 'object') {
      pushParts((status.message as Record<string, unknown>).parts)
    }
    if (Array.isArray(record.history)) {
      for (const message of record.history) {
        const role = message && typeof message === 'object'
          ? (message as Record<string, unknown>).role
          : undefined
        if (role !== 'agent' && role !== 'assistant') continue
        if (message && typeof message === 'object') {
          pushParts((message as Record<string, unknown>).parts)
        }
      }
    }
  }
  return [...new Set(texts)]
}
