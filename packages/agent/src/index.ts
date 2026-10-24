import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ContentPart, Message, ModelRequest, StopReason, ToolCallPart } from '@ruobai/llm'
import type { ModeDefinition } from '@ruobai/modes'
import type { SessionRecord } from '@ruobai/session'

export type TurnEndReason = 'done' | 'stopped' | 'error' | 'max-steps'

export interface RunOptions {
  /** Aborts the turn when this signal fires (e.g. the parent turn ending). */
  signal?: AbortSignal
  /** Overrides the mode/config step budget. */
  maxSteps?: number
  /** Tools hidden for this run only (prevents recursive sub-agents). */
  denyTools?: string[]
}

export interface RunResult {
  reason: TurnEndReason
  /** The last non-empty assistant text emitted during the turn. */
  text: string
}

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
  static inject = ['llm', 'sessions', 'tools', 'modes', 'context']

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

  /**
   * Append a user message and await the whole turn, returning its final text.
   * Used by sub-agents; `prompt` keeps its fire-and-forget contract.
   */
  async runToCompletion(sessionId: string, input: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.turns.has(sessionId)) throw new Error('session is already running')
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const message: UserMessageData = { id: randomUUID(), text: input, at: Date.now() }
    this.ctx.sessions.append(sessionId, 'message/user', message)
    if (record.meta.title === 'New session') {
      this.ctx.sessions.rename(sessionId, input.slice(0, 42) || 'New session')
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) controller.abort()
    this.turns.set(sessionId, controller)

    try {
      return await this.run(sessionId, controller, options)
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async run(sessionId: string, controller: AbortController, options: RunOptions = {}): Promise<RunResult> {
    let reason: TurnEndReason = 'done'
    let lastText = ''
    try {
      const record = this.ctx.sessions.get(sessionId)
      if (!record) throw new Error(`session disappeared: ${sessionId}`)
      const mode = this.ctx.modes.get(record.meta.mode) ?? this.ctx.modes.get(this.ctx.modes.defaultId())
      const maxSteps = options.maxSteps ?? mode?.maxSteps ?? this.config.maxSteps ?? 8
      const provider = this.providerName(record)
      const extra: Message[] = []
      let nudges = 0

      // Summarize older history before the request is assembled.
      await this.ctx.context.maybeCompact(sessionId, {
        provider,
        model: this.modelFor(record),
        signal: controller.signal,
        basePrompt: this.config.systemPrompt,
        modePrompt: mode?.systemPrompt,
        tools: this.toolsFor(mode, options.denyTools),
      })

      for (let step = 0; step < maxSteps; step += 1) {
        if (controller.signal.aborted) {
          reason = 'stopped'
          break
        }

        const messageId = randomUUID()
        this.ctx.emit('agent/step-start', sessionId, messageId)

        const request = await this.request(sessionId, controller.signal, mode, extra, options.denyTools)
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
        if (textContent) lastText = textContent

        const parts: ContentPart[] = []
        if (textContent) parts.push({ type: 'text', text: textContent })
        parts.push(...calls)
        if (parts.length) {
          this.ctx.sessions.append(sessionId, 'message/assistant', { id: messageId, parts, at: Date.now() })
        }

        if (!calls.length) {
          // Autonomous modes keep pushing until a completion tool fires.
          if (mode?.autonomous && nudges < 2 && !controller.signal.aborted) {
            nudges += 1
            extra.push({
              role: 'user',
              content: [{
                type: 'text',
                text: 'Continue toward the objective. Call goal_complete with a summary when it is achieved.',
              }],
            })
            continue
          }
          reason = stop === 'aborted' || controller.signal.aborted ? 'stopped' : 'done'
          break
        }

        let goalComplete = false
        for (const call of calls) {
          if (controller.signal.aborted) break
          if (!this.ctx.modes.allows(mode?.id, call.name)) {
            this.ctx.sessions.append(sessionId, 'tool/result', {
              callId: call.id,
              name: call.name,
              content: `tool "${call.name}" is not available in ${mode?.name ?? 'this'} mode`,
              isError: true,
            })
            continue
          }
          const args = parseArguments(call.arguments)
          const result = await this.ctx.tools.invoke(call.name, args, {
            signal: controller.signal,
            sessionId,
            callId: call.id,
          })
          this.ctx.sessions.append(sessionId, 'tool/result', {
            callId: call.id,
            name: call.name,
            content: result.content,
            isError: result.isError,
          })
          if (call.name === 'goal_complete') goalComplete = true
        }

        if (goalComplete) {
          reason = 'done'
          break
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
    return { reason, text: lastText }
  }

  private async request(
    sessionId: string,
    signal: AbortSignal,
    mode: ModeDefinition | undefined,
    extra: Message[],
    denyTools?: string[],
  ): Promise<ModelRequest> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const tools = this.toolsFor(mode, denyTools)
    const built = await this.ctx.context.build(sessionId, {
      basePrompt: this.config.systemPrompt,
      modePrompt: mode?.systemPrompt,
      extraMessages: extra,
      tools,
    })
    const messages: Message[] = built.system
      ? [{ role: 'system', content: [{ type: 'text', text: built.system }] }, ...built.messages]
      : built.messages

    return {
      messages,
      tools,
      signal,
      model: this.modelFor(record),
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    }
  }

  private toolsFor(mode: ModeDefinition | undefined, denyTools?: string[]) {
    return this.ctx.tools.list().filter(tool =>
      this.ctx.modes.allows(mode?.id, tool.name) && !denyTools?.includes(tool.name))
  }

  private modelFor(record: SessionRecord) {
    const settings = this.ctx.get('settings', false) as
      | { raw(): { llm?: { activeModel?: string } } }
      | undefined
    return record.meta.model ?? settings?.raw().llm?.activeModel ?? this.config.model
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

export default AgentService
