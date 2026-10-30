import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { LlmProvider, Message, ModelRequest, StopReason, StreamChunk, Usage } from '@ruobai/llm'

export interface Config {
  /** Provider name exposed through `ctx.llm`. */
  name?: string
  /** Base URL including the API version, e.g. `https://api.deepseek.com/v1`. */
  baseUrl?: string
  apiKey?: string
  /** Model advertised by this adapter; requests may still override it. */
  model?: string
  headers?: Record<string, string>
  /**
   * Abort when no bytes arrive for this long. The timer resets on every chunk,
   * so a slow but streaming reasoning model is never cut off mid-thought.
   */
  idleTimeoutMs?: number
  /** Hard cap on one attempt (ms). Unset means no total limit. */
  timeoutMs?: number
  /** Retries after a transient failure; only when nothing was streamed yet. */
  maxRetries?: number
  /** Base backoff between retries (ms), doubled per attempt. */
  retryDelayMs?: number
  /**
   * Send `prompt_cache_key` as a routing hint. Off by default: the field is a
   * Responses-API parameter and strict compatible servers reject unknown keys.
   */
  promptCacheKey?: boolean
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 800
const MAX_RETRY_DELAY_MS = 15_000
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
/** Provider error codes worth a retry: rate limits, overload, transport blips. */
const RETRYABLE_CODE = /rate.?limit|overload|timeout|timed.?out|unavailable|server_error|internal_error|bad_gateway|gateway|too_many_requests/i

type AttemptOutcome =
  | { kind: 'done' }
  | {
    kind: 'failed'
    message: string
    code?: string
    /** Safe to retry: nothing reached the caller, so a replay cannot duplicate text. */
    retryable: boolean
    retryAfterMs?: number
  }

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  const value = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - Date.now()
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 30_000) : undefined
}

function timeoutText(reason: 'idle' | 'total', config: Config) {
  const ms = reason === 'idle' ? (config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) : (config.timeoutMs ?? 0)
  return reason === 'idle'
    ? `provider stalled: no data for ${Math.round(ms / 1_000)}s`
    : `request timed out after ${Math.round(ms / 1_000)}s`
}

interface OpenAiToolCall {
  id: string
  name: string
  arguments: string
}

function toOpenAiMessages(messages: Message[]) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      const part = message.content.find(item => item.type === 'tool-result')
      return {
        role: 'tool',
        tool_call_id: part?.type === 'tool-result' ? part.callId : '',
        content: part?.type === 'tool-result' ? part.content : '',
      }
    }

    const calls = message.content
      .filter(part => part.type === 'tool-call')
      .map(part => ({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      }))

    // User turns carrying files or images must keep their part order for
    // vision-capable OpenAI-compatible endpoints.
    if (message.role === 'user' && message.content.some(part => part.type === 'image' || part.type === 'file')) {
      type OpenAiContentPart =
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      const content: OpenAiContentPart[] = []
      for (const part of message.content) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text })
        else if (part.type === 'file') {
          const path = part.path ? ` path="${escapeAttribute(part.path)}"` : ''
          content.push({
            type: 'text',
            text: `<file name="${escapeAttribute(part.name)}"${path}>\n${part.text}\n</file>`,
          })
        } else if (part.type === 'image') {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${part.mimeType};base64,${part.data}` },
          })
        }
      }
      return { role: message.role, content }
    }

    const text = message.content.map(part => part.type === 'text' ? part.text : '').join('')
    return {
      role: message.role,
      content: text || null,
      ...(calls.length ? { tool_calls: calls } : {}),
    }
  })
}

/** Providers disagree on the field name and shape of streamed reasoning. */
function reasoningText(delta: Record<string, unknown>): string {
  const raw = delta.reasoning_content ?? delta.reasoning
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item
        const text = item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined
        return typeof text === 'string' ? text : ''
      })
      .join('')
  }
  return ''
}

function toOpenAiTools(request: ModelRequest) {
  if (!request.tools?.length) return undefined
  return request.tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

/** HTTP surface the adapter needs; `ctx.net.fetch` supplies the proxy-aware one. */
export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** OpenAI-compatible `/chat/completions` adapter (DeepSeek, OpenAI, Ollama, vLLM). */
export class OpenAiProvider implements LlmProvider {
  name: string
  models: string[]

  constructor(
    private readonly config: Config,
    private readonly resolve?: () => Partial<Config>,
    private readonly fetchImpl: FetchImplementation = fetch as unknown as FetchImplementation,
  ) {
    this.name = config.name ?? 'openai'
    this.models = config.model ? [config.model] : []
  }

  /** Merge static config with live overrides (e.g. settings edited in the UI). */
  private current(): Config {
    return { ...this.config, ...this.resolve?.() }
  }

  async *stream(request: ModelRequest): AsyncIterable<StreamChunk> {
    const config = this.current()
    const maxRetries = Math.max(0, Math.floor(config.maxRetries ?? DEFAULT_MAX_RETRIES))
    for (let attempt = 0; ; attempt += 1) {
      const outcome = yield* this.attempt(request, config)
      if (outcome.kind === 'done') return
      // The caller pulled the plug; retrying would fight the stop button.
      if (request.signal?.aborted) {
        yield { type: 'done', reason: 'aborted' }
        return
      }
      if (!outcome.retryable || attempt >= maxRetries) {
        yield { type: 'error', message: outcome.message, ...(outcome.code ? { code: outcome.code } : {}) }
        yield { type: 'done', reason: 'stop' }
        return
      }
      const wait = outcome.retryAfterMs ?? Math.min(
        (config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * 2 ** attempt,
        MAX_RETRY_DELAY_MS,
      )
      if (!(await sleep(wait, request.signal))) {
        yield { type: 'done', reason: 'aborted' }
        return
      }
    }
  }

  /**
   * One request/stream attempt.
   *
   * A timeout is an error, never a fake `done`: the caller has to be able to
   * tell "the user stopped this" from "the provider went silent", otherwise a
   * half-finished thought would be persisted as a complete answer.
   */
  private async *attempt(request: ModelRequest, config: Config): AsyncGenerator<StreamChunk, AttemptOutcome> {
    const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    const controller = new AbortController()
    let timeoutReason: 'idle' | 'total' | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    const onCallerAbort = () => controller.abort()
    request.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (request.signal?.aborted) controller.abort()

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      const idleMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
      if (idleMs <= 0) return
      idleTimer = setTimeout(() => {
        timeoutReason ??= 'idle'
        controller.abort()
      }, idleMs)
    }
    const totalMs = config.timeoutMs ?? 0
    if (totalMs > 0) {
      totalTimer = setTimeout(() => {
        timeoutReason ??= 'total'
        controller.abort()
      }, totalMs)
    }
    armIdle()

    try {
      const post = (payload: Record<string, unknown>) => this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          ...config.headers,
        },
        body: JSON.stringify(payload),
      })

      const payload: Record<string, unknown> = {
        model: request.model ?? config.model,
        messages: toOpenAiMessages(request.messages),
        tools: toOpenAiTools(request),
        stream: true,
        // Token totals only arrive in a trailing frame when asked for. A few
        // compatible servers reject the field outright, so retry without it
        // instead of losing the whole turn.
        stream_options: { include_usage: true },
        ...(config.promptCacheKey && request.cache?.key ? { prompt_cache_key: request.cache.key } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      }

      let response: Response | undefined
      let failureBody = ''
      try {
        response = await post(payload)
        if (!response.ok) {
          failureBody = await response.text().catch(() => '')
          if (/stream_options/i.test(failureBody)) {
            const retry = { ...payload }
            delete retry.stream_options
            response = await post(retry)
            failureBody = response.ok ? '' : await response.text().catch(() => '')
          }
        }
      } catch (error) {
        if (request.signal?.aborted) {
          yield { type: 'done', reason: 'aborted' }
          return { kind: 'done' }
        }
        if (timeoutReason) {
          return { kind: 'failed', message: timeoutText(timeoutReason, config), code: 'timeout', retryable: true }
        }
        return {
          kind: 'failed',
          message: `request failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'network',
          retryable: true,
        }
      }

      if (!response || !response.ok || !response.body) {
        const code = errorCodeOf(failureBody)
        const status = response ? `${response.status} ${response.statusText}: ` : ''
        const retryable = response ? RETRYABLE_STATUS.has(response.status) : true
        return {
          kind: 'failed',
          message: `${status}${failureBody.slice(0, 500)}`,
          ...(code ? { code } : {}),
          retryable,
          ...(response ? { retryAfterMs: retryAfterMs(response) } : {}),
        }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const calls = new Map<number, OpenAiToolCall>()
      let buffer = ''
      let usage: Usage | undefined
      let stopReason: StopReason | undefined
      let finished = false
      /** Anything the caller already received: a replay would duplicate it. */
      let received = false
      // Headers are in: give the first token a full idle window instead of
      // charging it for the time the provider spent connecting.
      armIdle()

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          armIdle()
          buffer += decoder.decode(value, { stream: true })

          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')

            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (!data) continue
              if (data === '[DONE]') {
                finished = true
                break
              }

              let payload: any
              try {
                payload = JSON.parse(data)
              } catch {
                continue
              }

              if (payload.error) {
                const code = errorCodeOf(payload)
                const message = payload.error?.message ?? payload.error?.type ?? 'provider error'
                return {
                  kind: 'failed',
                  message: String(message),
                  ...(code ? { code } : {}),
                  retryable: !received && (!code || RETRYABLE_CODE.test(code)),
                }
              }

              const billed = readUsage(payload.usage)
              if (billed) usage = billed

              const choice = payload.choices?.[0]
              if (!choice) continue
              const delta = choice.delta ?? {}
              const thinking = reasoningText(delta)
              if (thinking) {
                received = true
                yield { type: 'reasoning-delta', text: thinking }
              }
              if (typeof delta.content === 'string' && delta.content) {
                received = true
                yield { type: 'text-delta', text: delta.content }
              }
              for (const call of delta.tool_calls ?? []) {
                received = true
                const index = call.index ?? 0
                const entry = calls.get(index) ?? { id: '', name: '', arguments: '' }
                if (call.id) entry.id = call.id
                if (call.function?.name) entry.name = call.function.name
                if (call.function?.arguments) entry.arguments += call.function.arguments
                calls.set(index, entry)
              }
              if (choice.finish_reason) {
                stopReason = choice.finish_reason === 'tool_calls'
                  ? 'tool-calls'
                  : choice.finish_reason === 'length' ? 'length' : 'stop'
              }
            }
            if (finished) break
          }
          if (finished) break
        }
      } catch (error) {
        if (request.signal?.aborted) {
          yield { type: 'done', reason: 'aborted' }
          return { kind: 'done' }
        }
        if (timeoutReason) {
          return {
            kind: 'failed',
            message: timeoutText(timeoutReason, config),
            code: 'timeout',
            retryable: !received,
          }
        }
        return {
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
          code: 'stream',
          retryable: !received,
        }
      }

      // A 200 with no deltas is almost always an upstream fault, not an answer.
      if (!received) {
        return { kind: 'failed', message: 'provider returned an empty response', code: 'empty', retryable: true }
      }

      for (const call of calls.values()) {
        yield {
          type: 'tool-call',
          id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: call.name,
          arguments: call.arguments || '{}',
        }
      }
      // `usage` is read at the end of the stream: some providers send the billed
      // totals in a trailing frame after `finish_reason`.
      yield {
        type: 'done',
        reason: stopReason ?? (calls.size ? 'tool-calls' : 'stop'),
        ...(usage ? { usage } : {}),
      }
      return { kind: 'done' }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      if (totalTimer) clearTimeout(totalTimer)
      request.signal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

/** Provider error code from a JSON body; also accepts a raw error string. */
function errorCodeOf(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    try {
      return errorCodeOf(JSON.parse(raw))
    } catch {
      return undefined
    }
  }
  if (!raw || typeof raw !== 'object') return undefined
  const body = raw as {
    error?: { code?: unknown; type?: unknown }
    code?: unknown
  }
  const code = body.error?.code ?? body.error?.type ?? body.code
  return typeof code === 'string' && code ? code : undefined
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Aliases of the same counter (`prompt_tokens` / `input_tokens`, …) are not
 * always filled consistently: some gateways send a zero placeholder next to the
 * real value, so the largest reported figure wins.
 */
function largestOf(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined)
  return defined.length ? Math.max(...defined) : undefined
}

/**
 * Normalize provider usage into disjoint harness counts.
 *
 * OpenAI and DeepSeek fold cache reads into `prompt_tokens`
 * (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`), so the
 * cached part has to be subtracted back out; gateways that follow the
 * Anthropic shape report it beside the prompt instead. Either way the reported
 * prompt is the billed total and drops out of `inputTokens`.
 */
function readUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const fields = raw as Record<string, any>
  const prompt = largestOf(toNumber(fields.prompt_tokens), toNumber(fields.input_tokens))
  const completion = largestOf(toNumber(fields.completion_tokens), toNumber(fields.output_tokens))
  const details = fields.prompt_tokens_details ?? fields.input_tokens_details ?? {}
  const cached = largestOf(
    toNumber(details.cached_tokens),
    toNumber(details.cache_read_tokens),
    toNumber(fields.prompt_cache_hit_tokens),
    toNumber(fields.cache_read_input_tokens),
  )
  const cachedWrite = largestOf(
    toNumber(details.cache_creation_tokens),
    toNumber(details.cache_write_tokens),
    toNumber(fields.cache_creation_input_tokens),
  )
  const usage: Usage = {}
  // A cache figure larger than the prompt count can only mean the provider
  // reports cache reads on top of the prompt; the prompt is already uncached.
  const folded = cached !== undefined && prompt !== undefined && cached <= prompt ? cached : undefined
  const uncached = prompt === undefined ? undefined : prompt - (folded ?? 0)
  if (uncached !== undefined) usage.inputTokens = uncached
  if (completion !== undefined) usage.outputTokens = completion
  // Keep an explicit zero: "0% cached" is a measurement, not a missing value.
  if (cached !== undefined) usage.cachedInputTokens = cached
  if (cachedWrite !== undefined) usage.cacheWriteInputTokens = cachedWrite
  return usage
}

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Registers an OpenAI-compatible provider. */
export default class OpenAiProviderPlugin {
  static inject = ['llm']

  static Config: z<Config> = z.object({
    name: z.string().default('openai'),
    baseUrl: z.string().default('https://api.openai.com/v1'),
    apiKey: z.string(),
    model: z.string(),
    headers: z.dict(z.string()),
    idleTimeoutMs: z.number().min(0).default(DEFAULT_IDLE_TIMEOUT_MS),
    timeoutMs: z.number().min(1),
    maxRetries: z.number().min(0).default(DEFAULT_MAX_RETRIES),
    retryDelayMs: z.number().min(0).default(DEFAULT_RETRY_DELAY_MS),
    promptCacheKey: z.boolean().default(false),
  })

  constructor(ctx: Context, config: Config) {
    ctx.effect(() => ctx.llm.register(new OpenAiProvider(config)), 'ctx.llm.register(openai)')
  }
}

export const meta = {
  title: 'OpenAI 兼容适配器',
  description: '接入 OpenAI 协议的模型服务。',
}
