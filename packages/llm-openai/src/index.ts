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
  timeoutMs?: number
  /**
   * Send `prompt_cache_key` as a routing hint. Off by default: the field is a
   * Responses-API parameter and strict compatible servers reject unknown keys.
   */
  promptCacheKey?: boolean
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

/** OpenAI-compatible `/chat/completions` adapter (DeepSeek, OpenAI, Ollama, vLLM). */
export class OpenAiProvider implements LlmProvider {
  name: string
  models: string[]

  constructor(
    private readonly config: Config,
    private readonly resolve?: () => Partial<Config>,
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
    const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    const signals: AbortSignal[] = []
    if (request.signal) signals.push(request.signal)
    if (config.timeoutMs) signals.push(AbortSignal.timeout(config.timeoutMs))
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

    const post = (payload: Record<string, unknown>) => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
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
      yield { type: 'error', message: `request failed: ${error instanceof Error ? error.message : String(error)}` }
      yield { type: 'done', reason: 'stop' }
      return
    }

    if (!response || !response.ok || !response.body) {
      const code = errorCodeOf(failureBody)
      const status = response ? `${response.status} ${response.statusText}: ` : ''
      yield {
        type: 'error',
        message: `${status}${failureBody.slice(0, 500)}`,
        ...(code ? { code } : {}),
      }
      yield { type: 'done', reason: 'stop' }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const calls = new Map<number, OpenAiToolCall>()
    let buffer = ''
    let usage: Usage | undefined
    let stopReason: StopReason | undefined
    let finished = false

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
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
              yield { type: 'error', message: String(message), ...(code ? { code } : {}) }
              finished = true
              break
            }

            const billed = readUsage(payload.usage)
            if (billed) usage = billed

            const choice = payload.choices?.[0]
            if (!choice) continue
            const delta = choice.delta ?? {}
            const thinking = reasoningText(delta)
            if (thinking) yield { type: 'reasoning-delta', text: thinking }
            if (typeof delta.content === 'string' && delta.content) {
              yield { type: 'text-delta', text: delta.content }
            }
            for (const call of delta.tool_calls ?? []) {
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
      if (signal?.aborted) {
        yield { type: 'done', reason: 'aborted' }
        return
      }
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) }
      yield { type: 'done', reason: 'stop' }
      return
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
    timeoutMs: z.number().min(1),
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
