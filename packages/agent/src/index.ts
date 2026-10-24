import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ContentPart, Message, ModelRequest, StopReason, ToolCallPart } from '@ruobai/llm'
import type { SessionEvent } from '@ruobai/session'

export type TurnEndReason = 'done' | 'stopped' | 'error' | 'max-steps'

export interface UserMessageData {
  id: string
  text: string
  at: number
}

export interface Config {
  systemPrompt?: string
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  provider?: string
  model?: string
}

declare module '@ruobai/cordis' {
  interface Context {
    agents: AgentService
  }

  interface Events {
    'agent/step-start'(sessionId: string, messageId: string): void
    'agent/delta'(sessionId: string, messageId: string, delta: string): void
    'agent/turn-end'(sessionId: string, reason: TurnEndReason): void
    'agent/error'(sessionId: string, message: string): void
  }
}

/**
 * Single-session turn driver.
 *
 * Each step streams one model response, persists it as `message/assistant`,
 * executes any tool calls (persisting `tool/result`), and loops until the
 * model stops calling tools. Raw deltas are ephemeral; only the assembled
 * message and tool results enter the session log.
 */
export class AgentService extends Service {
  static inject = ['llm', 'sessions', 'tools']

  static Config: z<Config> = z.object({
    systemPrompt: z.string().default(
      'You are ruobai, a concise assistant running inside the ruobai harness. Use tools when they help, and answer in the user\'s language.',
    ),
    maxSteps: z.number().min(1).default(8),
    maxTokens: z.number().min(1),
    temperature: z.number(),
    provider: z.string(),
    model: z.string(),
  })

  private readonly turns = new Map<string, AbortController>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agents')
    ctx.effect(() => () => {
      for (const controller of this.turns.values()) controller.abort()
      this.turns.clear()
    }, 'agents.abort-turns')
  }

  isRunning(sessionId: string) {
    return this.turns.has(sessionId)
  }

  prompt(sessionId: string, input: string): UserMessageData {
    if (this.turns.has(sessionId)) throw new Error('session is already running')
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const message: UserMessageData = { id: randomUUID(), text: input, at: Date.now() }
    this.ctx.sessions.append(sessionId, 'message/user', message)
    if (record.meta.title === 'New session') {
      this.ctx.sessions.rename(sessionId, input.slice(0, 42) || 'New session')
    }

    const controller = new AbortController()
    this.turns.set(sessionId, controller)
    void this.run(sessionId, controller)
    return message
  }

  stop(sessionId: string) {
    this.turns.get(sessionId)?.abort()
  }

  private async run(sessionId: string, controller: AbortController) {
    let reason: TurnEndReason = 'done'
    try {
      const maxSteps = this.config.maxSteps ?? 8
      for (let step = 0; step < maxSteps; step += 1) {
        if (controller.signal.aborted) {
          reason = 'stopped'
          break
        }

        const record = this.ctx.sessions.get(sessionId)
        if (!record) throw new Error(`session disappeared: ${sessionId}`)

        const messageId = randomUUID()
        this.ctx.emit('agent/step-start', sessionId, messageId)

        const request = this.request(sessionId, controller.signal)
        const provider = this.providerName(record)
        let textContent = ''
        const calls: ToolCallPart[] = []
        let failure: string | undefined
        let stop: StopReason = 'stop'

        for await (const chunk of this.ctx.llm.stream(request, provider)) {
          if (chunk.type === 'text-delta') {
            textContent += chunk.text
            this.ctx.emit('agent/delta', sessionId, messageId, chunk.text)
          } else if (chunk.type === 'tool-call') {
            calls.push({ type: 'tool-call', id: chunk.id, name: chunk.name, arguments: chunk.arguments })
          } else if (chunk.type === 'error') {
            failure = chunk.message
          } else {
            stop = chunk.reason ?? 'stop'
          }
        }

        if (failure) throw new Error(failure)

        const parts: ContentPart[] = []
        if (textContent) parts.push({ type: 'text', text: textContent })
        parts.push(...calls)
        if (parts.length) {
          this.ctx.sessions.append(sessionId, 'message/assistant', { id: messageId, parts, at: Date.now() })
        }

        if (!calls.length) {
          reason = stop === 'aborted' ? 'stopped' : 'done'
          break
        }

        for (const call of calls) {
          if (controller.signal.aborted) break
          const args = parseArguments(call.arguments)
          const result = await this.ctx.tools.invoke(call.name, args, {
            signal: controller.signal,
            sessionId,
          })
          this.ctx.sessions.append(sessionId, 'tool/result', {
            callId: call.id,
            name: call.name,
            content: result.content,
            isError: result.isError,
          })
        }

        if (step === maxSteps - 1) reason = 'max-steps'
      }
    } catch (error) {
      reason = 'error'
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.ctx.sessions.append(sessionId, 'turn/error', { message })
      } catch {
        // session removed mid-turn
      }
      this.ctx.emit('agent/error', sessionId, message)
    } finally {
      this.turns.delete(sessionId)
      this.ctx.emit('agent/turn-end', sessionId, reason)
    }
  }

  private request(sessionId: string, signal: AbortSignal): ModelRequest {
    const record = this.ctx.sessions.get(sessionId)!
    const messages: Message[] = []
    if (this.config.systemPrompt) {
      messages.push({ role: 'system', content: [{ type: 'text', text: this.config.systemPrompt }] })
    }
    for (const event of record.events) {
      messages.push(...toMessages(event))
    }
    const settings = this.ctx.get('settings', false) as
      | { raw(): { llm?: { activeModel?: string } } }
      | undefined
    return {
      messages,
      tools: this.ctx.tools.list(),
      signal,
      model: record.meta.model ?? settings?.raw().llm?.activeModel ?? this.config.model,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    }
  }

  /** Prefer the session's provider, then the active one, then the config; never return an unregistered name. */
  private providerName(record: { meta: { provider?: string } }) {
    const settings = this.ctx.get('settings', false) as
      | { raw(): { llm?: { activeProvider?: string } } }
      | undefined
    const candidates = [record.meta.provider, settings?.raw().llm?.activeProvider, this.config.provider]
    for (const name of candidates) {
      if (name && this.ctx.llm.get(name)) return name
    }
    return 'mock'
  }
}

function parseArguments(raw: string) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

function toMessages(event: SessionEvent): Message[] {
  if (event.type === 'message/user') {
    return [{ role: 'user', content: [{ type: 'text', text: event.data.text }] }]
  }
  if (event.type === 'message/assistant') {
    return [{ role: 'assistant', content: event.data.parts }]
  }
  if (event.type === 'tool/result') {
    return [{
      role: 'tool',
      content: [{
        type: 'tool-result',
        callId: event.data.callId,
        name: event.data.name,
        content: event.data.content,
        isError: event.data.isError,
      }],
    }]
  }
  return []
}

export default AgentService
