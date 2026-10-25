import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { LlmProvider, ModelRequest, StreamChunk } from './types.ts'

export * from './types.ts'

export interface Config {
  /** Provider used when a request does not name one. */
  provider?: string
  /** Model used when a request does not name one. */
  model?: string
  temperature?: number
  maxTokens?: number
}

declare module '@ruobai/cordis' {
  interface Context {
    llm: LlmService
  }

  interface Events {
    'llm/provider-added'(name: string): void
    'llm/provider-removed'(name: string): void
  }
}

/**
 * Provider registry and the single entry point for model calls.
 *
 * Adapters are plain objects; the registering plugin owns their lifetime by
 * wrapping `register()` in `ctx.effect()`. Unknown providers surface as an
 * `error` chunk instead of throwing, so callers can render the failure.
 */
export class LlmService extends Service {
  static Config: z<Config> = z.object({
    provider: z.string().default('mock'),
    model: z.string().default('mock-1'),
    temperature: z.number(),
    maxTokens: z.number(),
  })

  private readonly providers = new Map<string, LlmProvider>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'llm')
  }

  register(provider: LlmProvider): () => void {
    if (this.providers.has(provider.name)) {
      throw new Error(`llm provider "${provider.name}" is already registered`)
    }
    this.providers.set(provider.name, provider)
    this.ctx.emit('llm/provider-added', provider.name)
    return () => {
      if (this.providers.get(provider.name) !== provider) return
      this.providers.delete(provider.name)
      this.ctx.emit('llm/provider-removed', provider.name)
    }
  }

  get(name: string) {
    return this.providers.get(name)
  }

  list() {
    return [...this.providers.values()].map(provider => ({ name: provider.name, models: provider.models ?? [] }))
  }

  /** Stream a request; the trailing `done` chunk is guaranteed on success. */
  async *stream(request: Omit<ModelRequest, 'model'> & { model?: string }, providerName?: string): AsyncIterable<StreamChunk> {
    const name = providerName ?? this.config.provider ?? 'mock'
    const provider = this.providers.get(name)
    if (!provider) {
      yield { type: 'error', message: `unknown llm provider "${name}"` }
      yield { type: 'done', reason: 'stop' }
      return
    }

    const model = request.model ?? this.config.model ?? provider.models?.[0]
    const merged: ModelRequest = {
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      ...request,
      ...(model ? { model } : {}),
    }

    let finished = false
    for await (const chunk of provider.stream(merged)) {
      if (chunk.type === 'done') finished = true
      yield chunk
    }
    if (!finished) yield { type: 'done', reason: 'stop' }
  }

  /** Collect a stream into text plus tool calls; useful for non-streaming callers. */
  async complete(request: Omit<ModelRequest, 'model'> & { model?: string }, providerName?: string) {
    let content = ''
    const calls: Array<{ id: string; name: string; arguments: string }> = []
    let error: string | undefined
    let errorCode: string | undefined
    let reason: string | undefined
    for await (const chunk of this.stream(request, providerName)) {
      if (chunk.type === 'text-delta') content += chunk.text
      else if (chunk.type === 'tool-call') calls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments })
      else if (chunk.type === 'error') {
        error = chunk.message
        errorCode = chunk.code
      } else reason = chunk.reason
    }
    return { content, calls, error, errorCode, reason }
  }
}

export default LlmService

export const meta = {
  title: '模型服务',
  description: '为不同模型提供统一的调用接口。',
}
