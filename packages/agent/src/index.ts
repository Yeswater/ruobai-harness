import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import { isContextOverflow } from '@ruobai/context'
import type { AttachmentMeta, TurnStats } from '@ruobai/chat-protocol'
import type { ContentPart, Message, ModelRequest, StopReason, ToolCallPart } from '@ruobai/llm'
import type { ModeDefinition } from '@ruobai/modes'
import type { SessionRecord } from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'

export type TurnEndReason = 'done' | 'stopped' | 'error' | 'max-steps'

/**
 * A step whose deltas all land inside one burst has no measurable duration;
 * timing it would report a fictional rate.
 */
const MIN_STREAM_MS = 250

export interface RunOptions {
  /** Aborts the turn when this signal fires (e.g. the parent turn ending). */
  signal?: AbortSignal
  /**
   * Step budget for delegated runs. Interactive turns are unbounded: they end
   * when the model stops calling tools, the user stops them, or an error hits.
   */
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
  attachments?: AttachmentMeta[]
  /** Host-side context injected for a user gesture; hidden from the transcript. */
  source?: { kind: 'skill'; name: string; forMessageId: string }
}

export interface Config {
  systemPrompt?: string
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
    'agent/reasoning'(sessionId: string, messageId: string, delta: string): void
    'agent/turn-end'(sessionId: string, reason: TurnEndReason): void
    'agent/error'(sessionId: string, message: string): void
    'agent/usage'(sessionId: string, stats: TurnStats): void
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

  prompt(sessionId: string, input: string, attachments: AttachmentMeta[] = []): UserMessageData {
    if (this.turns.has(sessionId)) throw new Error('session is already running')
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const message: UserMessageData = {
      id: randomUUID(),
      text: input,
      at: Date.now(),
      ...(attachments.length ? { attachments } : {}),
    }
    this.ctx.sessions.append(sessionId, 'message/user', message)
    if (record.meta.title === 'New session') {
      const fallback = input.trim().slice(0, 42) || attachments[0]?.name.slice(0, 42)
      this.ctx.sessions.rename(sessionId, fallback || 'New session')
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
    const startedAt = Date.now()
    let firstDeltaAt: number | undefined
    // Time the model spent streaming, summed over the steps that streamed
    // visibly: tool round trips in between must not dilute the rate.
    let generationMs = 0
    // Output tokens produced inside those measured windows. Without it the
    // rate would divide step-spanning totals by a partial window.
    let streamedTokens = 0
    let outputChars = 0
    let steps = 0
    let usageSeen = false
    let cacheSeen = false
    let inputTokens = 0
    let outputTokens = 0
    let cachedInputTokens = 0
    try {
      const record = this.ctx.sessions.get(sessionId)
      if (!record) throw new Error(`session disappeared: ${sessionId}`)
      const mode = this.ctx.modes.get(record.meta.mode) ?? this.ctx.modes.get(this.ctx.modes.defaultId())
      const maxSteps = options.maxSteps
      const provider = this.providerName(record)
      const extra: Message[] = []
      let nudges = 0
      let overflowRetries = 0

      // `/name` in the user's message loads that skill for this turn.
      await this.injectSkillGestures(sessionId)

      const compactOptions = () => ({
        provider,
        model: this.modelFor(record),
        signal: controller.signal,
        basePrompt: this.config.systemPrompt,
        modePrompt: mode?.systemPrompt,
        tools: this.toolsFor(sessionId, mode, options.denyTools),
      })

      // `/compact [focus]` is a maintenance gesture: summarize now and end the
      // turn without a model call.
      const focus = this.compactCommand(sessionId)
      if (focus !== undefined) {
        const info = await this.ctx.context.compactNow(sessionId, {
          ...compactOptions(),
          ...(focus ? { focus } : {}),
        })
        this.ctx.sessions.append(sessionId, 'turn/notice', info
          ? { kind: 'compacted', before: info.before, after: info.after, trigger: 'manual' }
          : { kind: 'compact-empty' })
        return { reason: 'done', text: '' }
      }

      // Summarize older history before the turn's first request.
      await this.ctx.context.maybeCompact(sessionId, compactOptions())

      while (true) {
        if (controller.signal.aborted) {
          reason = 'stopped'
          break
        }

        // Tool output can balloon mid-turn; re-check pressure before every
        // follow-up request instead of only once per turn.
        if (steps > 0) await this.ctx.context.maybeCompact(sessionId, compactOptions())

        const messageId = randomUUID()
        steps += 1
        this.ctx.emit('agent/step-start', sessionId, messageId)

        const built = await this.request(sessionId, controller.signal, mode, extra, options.denyTools)
        let reasoningContent = ''
        let textContent = ''
        const calls: ToolCallPart[] = []
        let failure: string | undefined
        let failureCode: string | undefined
        let stop: StopReason = 'stop'
        let stepInputTokens = 0
        let stepFirstDeltaAt: number | undefined
        let stepLastDeltaAt: number | undefined
        let stepOutputTokens = 0

        try {
          for await (const chunk of this.ctx.llm.stream(built.request, provider)) {
            if (chunk.type === 'reasoning-delta') {
              reasoningContent += chunk.text
              // Reasoning is billed as output: it belongs to the same window.
              const now = Date.now()
              firstDeltaAt ??= now
              stepFirstDeltaAt ??= now
              stepLastDeltaAt = now
              this.ctx.emit('agent/reasoning', sessionId, messageId, chunk.text)
            } else if (chunk.type === 'text-delta') {
              textContent += chunk.text
              outputChars += chunk.text.length
              const now = Date.now()
              firstDeltaAt ??= now
              stepFirstDeltaAt ??= now
              stepLastDeltaAt = now
              this.ctx.emit('agent/delta', sessionId, messageId, chunk.text)
            } else if (chunk.type === 'tool-call') {
              calls.push({ type: 'tool-call', id: chunk.id, name: chunk.name, arguments: chunk.arguments })
            } else if (chunk.type === 'error') {
              failure = chunk.message
              failureCode = chunk.code
            } else {
              stop = chunk.reason ?? 'stop'
              if (chunk.usage) {
                usageSeen = true
                inputTokens += chunk.usage.inputTokens ?? 0
                outputTokens += chunk.usage.outputTokens ?? 0
                if (chunk.usage.cachedInputTokens !== undefined) {
                  cacheSeen = true
                  cachedInputTokens += chunk.usage.cachedInputTokens
                }
                stepInputTokens += chunk.usage.inputTokens ?? 0
                stepOutputTokens += chunk.usage.outputTokens ?? 0
              }
            }
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }

        // Only count a step's tokens when its stream was actually observable:
        // buffered or single-frame answers have no usable window.
        if (stepFirstDeltaAt !== undefined && stepLastDeltaAt !== undefined) {
          const span = stepLastDeltaAt - stepFirstDeltaAt
          if (span >= MIN_STREAM_MS) {
            generationMs += span
            streamedTokens += stepOutputTokens
          }
        }

        // Anchor the estimator to what the provider actually billed.
        if (stepInputTokens) this.ctx.context.observeUsage(sessionId, built.estimatedTokens, stepInputTokens)

        if (failure) {
          if (isContextOverflow(failure, failureCode) && overflowRetries < 1) {
            overflowRetries += 1
            const info = await this.ctx.context.forceCompact(sessionId, compactOptions())
            if (info) {
              this.ctx.sessions.append(sessionId, 'turn/notice', {
                kind: 'compacted',
                before: info.before,
                after: info.after,
                trigger: 'overflow',
              })
              continue
            }
          }
          throw new Error(failure)
        }
        if (textContent) lastText = textContent

        const parts: ContentPart[] = []
        if (reasoningContent) parts.push({ type: 'reasoning', text: reasoningContent })
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
            workspace: record.meta.workspace,
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
        if (maxSteps !== undefined && steps >= maxSteps) {
          reason = 'max-steps'
          // Delegated runs stop silently otherwise; record why the turn ended.
          this.ctx.sessions.append(sessionId, 'turn/notice', { kind: 'max-steps', steps: maxSteps })
          break
        }
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
      const stats: TurnStats = {
        ...(usageSeen ? {
          inputTokens,
          outputTokens,
          ...(cacheSeen ? { cachedInputTokens } : {}),
        } : {}),
        ...(firstDeltaAt !== undefined ? { ttftMs: firstDeltaAt - startedAt } : {}),
        ...(generationMs ? { generationMs } : {}),
        ...(streamedTokens ? { streamedOutputTokens: streamedTokens } : {}),
        durationMs: Date.now() - startedAt,
        steps,
        outputChars,
      }
      this.ctx.emit('agent/usage', sessionId, stats)
    }
    return { reason, text: lastText }
  }

  private async request(
    sessionId: string,
    signal: AbortSignal,
    mode: ModeDefinition | undefined,
    extra: Message[],
    denyTools?: string[],
  ): Promise<{ request: ModelRequest; estimatedTokens: number }> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const tools = this.toolsFor(sessionId, mode, denyTools)
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
      request: {
        messages,
        tools,
        signal,
        model: this.modelFor(record),
        temperature: this.config.temperature,
        maxTokens: this.maxTokensFor(record),
      },
      estimatedTokens: built.estimatedTokens,
    }
  }

  private maxTokensFor(record: SessionRecord): number | undefined {
    const settings = this.ctx.get('settings', false) as
      | {
        findProvider?(id: string): {
          models: Array<{ id: string; maxOutputTokens?: number }>
        } | undefined
      }
      | undefined
    const model = record.meta.provider
      ? settings?.findProvider?.(record.meta.provider)?.models.find(
        item => item.id === this.modelFor(record),
      )
      : undefined
    const limit = model?.maxOutputTokens
    const configured = this.config.maxTokens
    if (configured && limit) return Math.min(configured, limit)
    return configured ?? limit
  }

  /** `/compact` or `/compact <focus>` in the latest user message. */
  private compactCommand(sessionId: string): string | undefined {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return
    const lastUser = [...record.events].reverse().find(event =>
      event.type === 'message/user' && event.data?.source?.kind !== 'skill')
    if (!lastUser) return
    const match = /^\/compact(?:\s+([\s\S]+))?$/i.exec(String(lastUser.data?.text ?? '').trim())
    if (!match) return
    return match[1]?.trim() ?? ''
  }

  /**
   * Turns `/name` tokens in the latest user message into persisted skill
   * context. The event carries a `source` marker so the transcript can skip it.
   */
  private async injectSkillGestures(sessionId: string) {
    const skills = this.ctx.get('skills', false) as
      | {
        get(name: string, sessionId?: string): Promise<{ userInvocable: boolean } | undefined>
        render(name: string, sessionId?: string): Promise<string | undefined>
      }
      | undefined
    if (!skills) return
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return
    const lastUser = [...record.events].reverse().find(event =>
      event.type === 'message/user' && event.data?.source?.kind !== 'skill')
    if (!lastUser) return
    const text = String(lastUser.data?.text ?? '')
    const names = [...text.matchAll(/(^|\s)\/([a-z0-9][a-z0-9-]*)/gi)]
      .map(match => match[2]!.toLowerCase())
    for (const name of new Set(names)) {
      const already = record.events.some(event => event.type === 'message/user'
        && event.data?.source?.kind === 'skill'
        && event.data.source.name === name
        && event.data.source.forMessageId === lastUser.data.id)
      if (already) continue
      const skill = await skills.get(name, sessionId)
      if (!skill?.userInvocable) continue
      const rendered = await skills.render(name, sessionId)
      if (!rendered) continue
      this.ctx.sessions.append(sessionId, 'message/user', {
        id: randomUUID(),
        text: rendered,
        at: Date.now(),
        source: { kind: 'skill', name, forMessageId: lastUser.data.id },
      })
    }
  }

  private toolsFor(sessionId: string, mode: ModeDefinition | undefined, denyTools?: string[]) {
    const permissions = this.ctx.get('permissions', false) as
      | { allowsTool(sessionId: string | undefined, tool: ToolDefinition | undefined): boolean }
      | undefined
    return this.ctx.tools.list().filter((tool) => {
      if (!this.ctx.modes.allows(mode?.id, tool.name)) return false
      if (denyTools?.includes(tool.name)) return false
      if (!permissions) return true
      return permissions.allowsTool(sessionId, this.ctx.tools.get(tool.name))
    })
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

export const meta = {
  title: '智能体驱动',
  description: '驱动模型、工具调用与多步回合。',
}
