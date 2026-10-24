import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { LlmProvider, Message, ModelRequest, StreamChunk, Usage } from '@ruobai/llm'

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

    const text = message.content.map(part => part.type === 'text' ? part.text : '').join('')
    const calls = message.content
      .filter(part => part.type === 'tool-call')
      .map(part => ({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      }))
    return {
      role: message.role,
      content: text || null,
      ...(calls.length ? { tool_calls: calls } : {}),
    }
  })
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

    let response: Response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          ...config.headers,
        },
        body: JSON.stringify({
          model: request.model ?? config.model,
          messages: toOpenAiMessages(request.messages),
          tools: toOpenAiTools(request),
          stream: true,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        }),
      })
    } catch (error) {
      yield { type: 'error', message: `request failed: ${error instanceof Error ? error.message : String(error)}` }
      yield { type: 'done', reason: 'stop' }
      return
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '')
      yield { type: 'error', message: `${response.status} ${response.statusText}: ${body.slice(0, 500)}` }
      yield { type: 'done', reason: 'stop' }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const calls = new Map<number, OpenAiToolCall>()
    let buffer = ''
    let usage: Usage | undefined
    let reason: StreamChunk & { type: 'done' } | undefined
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

            if (payload.usage) {
              usage = {
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: payload.usage.completion_tokens,
              }
            }

            const choice = payload.choices?.[0]
            if (!choice) continue
            const delta = choice.delta ?? {}
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
              reason = { type: 'done', reason: choice.finish_reason === 'tool_calls' ? 'tool-calls' : 'stop', usage }
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
    yield reason ?? { type: 'done', reason: calls.size ? 'tool-calls' : 'stop', usage }
  }
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
  })

  constructor(ctx: Context, config: Config) {
    ctx.effect(() => ctx.llm.register(new OpenAiProvider(config)), 'ctx.llm.register(openai)')
  }
}
