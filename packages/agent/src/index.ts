import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import { isContextOverflow, type PrefixDivergence } from '@ruobai/context'
import type { AttachmentMeta, TurnStats } from '@ruobai/chat-protocol'
import type { ContentPart, Message, ModelRequest, StopReason, ToolCallPart, Usage } from '@ruobai/llm'
import type { ModeDefinition } from '@ruobai/modes'
import type { ToolDefinition } from '@ruobai/tools'
import type { SessionRecord } from '@ruobai/session'

export type TurnEndReason = 'done' | 'stopped' | 'error' | 'max-steps'

/**
 * Timing boundaries persisted beside each assistant message: request dispatch →
 * first streamed token → assembled message. Everything time-derived (TTFT, the
 * decode rate) folds from these stamps, so a reloaded session reports exactly
 * what a live one did.
 */
/**
 * Shortest decode window worth dividing by. A step that delivered every token
 * inside one flush has no measurable rate; timing it produced figures like
 * "26000 tok/s" that no provider can serve.
 */
const MIN_DECODE_MS = 50

export interface StepTiming {
  stepStartTime: number
  /** First text or reasoning delta; absent when the step streamed nothing. */
  firstTokenTime?: number
  /** When the assembled message was appended to the log. */
  completedTime: number
}

/** Sum two usage records for the same step (streamed totals arrive in pieces). */
function mergeUsage(left: Usage, right: Usage): Usage {
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0))
  const inputTokens = sum(left.inputTokens, right.inputTokens)
  const outputTokens = sum(left.outputTokens, right.outputTokens)
  const cachedInputTokens = sum(left.cachedInputTokens, right.cachedInputTokens)
  const cacheWriteInputTokens = sum(left.cacheWriteInputTokens, right.cacheWriteInputTokens)
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  }
}

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

export interface PromptOptions {
  /** Reuse an id the caller already showed (a queued message). */
  id?: string
}

/**
 * Messages the user sent while a turn was running.
 *
 * They are appended at a step boundary — after the current step's tool calls
 * finished and before the next request — so the model reads them in the same
 * turn instead of the step being produced getting cut off. Returning them
 * transfers ownership: the source must drop them from whatever it showed.
 */
export type InterjectionSource = (sessionId: string) => UserMessageData[]

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
  /** Host-injected context; hidden from the transcript. */
  source?: { kind: 'skill' | 'hook'; name: string; forMessageId: string }
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
    systemPrompt: z.string().default([
      'You are ruobai, an agent running inside the ruobai harness.',
      'Use tools instead of guessing, and answer in the user\'s language.',
      // Reasoning models echo the prompt's language; the UI shows the trace to
      // a Chinese-reading user, so ask for it explicitly.
      'Write your reasoning in Simplified Chinese (中文) even when the request is in another language.',
      '',
      '## Working style',
      '- Keep each reasoning block short: name the next concrete check, not a survey of hypothetical paths.',
      '- Do not describe code you have not read. Read it, then speak.',
      '- For a reported bug, reproduce it before changing code. If the report and the code disagree, say what you observed and ask for the missing repro step instead of exploring every plausible cause.',
      '- Before editing, state the root cause in one or two sentences and name the files you will change.',
      '- After each change, run the narrowest check that can fail (targeted test, typecheck, the command under test); run the full suite before declaring the work done.',
      '- Never call a fix verified without running it. If a check could not run, say so plainly.',
      '',
      '## Paths and environment',
      // The workspace and the file tools are a hard boundary; a session opened
      // on a temp directory cannot edit the repository it is asked about.
      '- File tools (read_file, list_dir, glob, grep, edit_file, write_file) resolve paths against the workspace root in the Environment section. Absolute paths are accepted only inside that root; anything outside is rejected.',
      '- bash starts in the workspace root but is sandboxed. If the target repository is outside the workspace, stop and ask the user to point the session workspace at it. If they instead open the sandbox and tell you to edit in place, bash is the only route: keep the change small and review the diff.',
      '- Put temporary or scratch files under .ruobai/scratch/ inside the workspace, never in the source tree.',
      '- For files larger than the read cap, page through them with read_file offset/limit; edit_file rewrites the whole file and has a separate, larger cap.',
      '',
      '## Tool choice',
      '- Read with read_file, list with list_dir, search with grep/glob. Do not use bash cat/sed/head/tail/grep/find/ls to inspect workspace files.',
      '- Edit with edit_file (one exact occurrence) or write_file (new or whole file). When a file tool can reach the file, never rewrite it through shell redirection, sed or python: checkpoints, diffs and approvals only work through those tools.',
      '- Run commands, builds, tests and git with bash. Keep one purpose per call; do not chain unrelated commands with && or ; to save a step.',
      // Independent reads run concurrently in one step; a weaker model that
      // issues them serially roughly doubles the turn length.
      '- Batch independent calls: several read_file/grep/glob calls in one step. Keep dependent calls in separate steps and writers serial.',
      '- Browser: take browser_snapshot for uids, then use browser_click/browser_fill. Use browser_eval only to inspect state, never to click, type or scroll; re-snapshot after the UI changes.',
      '- Use todo_write when the work takes three or more steps, with one item in progress. Use ask_user when the request has several plausible meanings.',
      '- Use task (when available) for broad, independent research.',
      '- Domain tools (Gitee, wiki, memory, contracts, delivery, plan) are not loaded by default. When the task enters one of those domains, call tool_search first; the matching tools become available on the next step.',
      '',
      '## Boundaries',
      '- A sandbox denial that says the resource is not allowed is final: report it and ask the user, never retry with another command or path.',
      '- Before starting a dev server or long-running process, check whether one is already running; log under .ruobai/scratch, wait briefly instead of sleeping in long blocks, and stop it when done.',
      '- Do not git commit unless the user asks; this harness offers a commit card when a turn ends.',
    ].join('\n')),
    maxTokens: z.number().min(1),
    temperature: z.number(),
    provider: z.string(),
    model: z.string(),
  })

  private readonly turns = new Map<string, AbortController>()
  private interjections: InterjectionSource | undefined

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agents')
    ctx.effect(() => ctx.tools.register(this.searchTool()), 'agents.tool-search')
    ctx.effect(() => () => {
      for (const controller of this.turns.values()) controller.abort()
      this.turns.clear()
    }, 'agents.abort-turns')
  }

  /** Wired by the chat service: its queue is what a turn may interject with. */
  registerInterjections(source: InterjectionSource): () => void {
    this.interjections = source
    return () => {
      if (this.interjections === source) this.interjections = undefined
    }
  }

  isRunning(sessionId: string) {
    return this.turns.has(sessionId)
  }

  prompt(
    sessionId: string,
    input: string,
    attachments: AttachmentMeta[] = [],
    options: PromptOptions = {},
  ): UserMessageData {
    if (this.turns.has(sessionId)) throw new Error('session is already running')
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const message: UserMessageData = {
      // A queued message keeps the id the UI already showed while it waited.
      id: options.id ?? randomUUID(),
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
    // Decode window and the tokens decoded inside it: a step contributes to both
    // or to neither, so the rate always divides the work it measured.
    let decodeMs = 0
    let decodedTokens = 0
    let outputChars = 0
    let steps = 0
    let usageSeen = false
    let inputTokens = 0
    let outputTokens = 0
    let cachedInputTokens = 0
    let cacheWriteInputTokens = 0
    try {
      const record = this.ctx.sessions.get(sessionId)
      if (!record) throw new Error(`session disappeared: ${sessionId}`)
      const mode = this.ctx.modes.get(record.meta.mode) ?? this.ctx.modes.get(this.ctx.modes.defaultId())
      const maxSteps = options.maxSteps
      const provider = this.providerName(record)
      const extra: Message[] = []
      let nudges = 0
      let overflowRetries = 0

      // A registered slash command is a maintenance gesture: run it and end
      // the turn without a model call. It wins over `/<skill>` gestures.
      const commands = this.ctx.get('commands', false) as
        | { dispatch(sessionId: string): Promise<boolean> }
        | undefined
      if (commands && await commands.dispatch(sessionId)) {
        return { reason: 'done', text: '' }
      }

      // `/name` in the user's message loads that skill for this turn.
      await this.injectSkillGestures(sessionId)

      const compactOptions = () => ({
        provider,
        model: this.modelFor(record),
        signal: controller.signal,
        basePrompt: this.config.systemPrompt,
        modePrompt: mode?.systemPrompt,
        tools: this.toolsFor(mode, options.denyTools, sessionId),
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

        // A message the user sent while this turn ran waits for a step to
        // settle; admitting it mid-stream would cut the step it is answering.
        // `steps > 0` keeps the first request exactly as prompt() submitted it.
        if (steps > 0) this.admitInterjections(sessionId)

        // Tool output can balloon mid-turn; re-check pressure before every
        // follow-up request instead of only once per turn.
        if (steps > 0) await this.ctx.context.maybeCompact(sessionId, compactOptions())

        const messageId = randomUUID()
        steps += 1
        const stepStartTime = Date.now()
        this.ctx.emit('agent/step-start', sessionId, messageId)

        const built = await this.request(sessionId, controller.signal, mode, extra, options.denyTools)
        // One record per turn: what the first request of this turn was assembled
        // from. Later steps see the same prompt unless compaction rewrote it,
        // and those rewrites already carry their own context events.
        if (steps === 1) this.recordContext(sessionId, built, mode)
        let reasoningContent = ''
        let textContent = ''
        const calls: ToolCallPart[] = []
        let failure: string | undefined
        let failureCode: string | undefined
        let stop: StopReason = 'stop'
        let stepInputTokens = 0
        let stepFirstTokenTime: number | undefined
        let stepUsage: Usage | undefined

        try {
          for await (const chunk of this.ctx.llm.stream(built.request, provider)) {
            if (chunk.type === 'reasoning-delta') {
              reasoningContent += chunk.text
              // Reasoning is billed as output: it belongs to the same window.
              const now = Date.now()
              firstDeltaAt ??= now
              stepFirstTokenTime ??= now
              this.ctx.emit('agent/reasoning', sessionId, messageId, chunk.text)
            } else if (chunk.type === 'text-delta') {
              textContent += chunk.text
              outputChars += chunk.text.length
              const now = Date.now()
              firstDeltaAt ??= now
              stepFirstTokenTime ??= now
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
                cachedInputTokens += chunk.usage.cachedInputTokens ?? 0
                cacheWriteInputTokens += chunk.usage.cacheWriteInputTokens ?? 0
                stepInputTokens += chunk.usage.inputTokens ?? 0
                stepUsage = stepUsage ? mergeUsage(stepUsage, chunk.usage) : chunk.usage
              }
            }
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
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
        // The stream can stop without the caller aborting only when the
        // provider gives up (it never reports a timeout as a normal stop).
        const aborted = controller.signal.aborted || stop === 'aborted'

        const parts: ContentPart[] = []
        if (reasoningContent) parts.push({ type: 'reasoning', text: reasoningContent })
        if (textContent) parts.push({ type: 'text', text: textContent })
        parts.push(...calls)

        // Fold timing and billing in as the step settles. Both ride the log next
        // to the message, so a reloaded session recomputes the same readings.
        const completedTime = Date.now()
        const timing: StepTiming = {
          stepStartTime,
          ...(stepFirstTokenTime !== undefined ? { firstTokenTime: stepFirstTokenTime } : {}),
          completedTime,
        }
        // A window this short cannot have decoded anything: it means the whole
        // step arrived in one buffered burst (or a replayed stream), and timing
        // it would report a rate no model reaches.
        const decodeWindow = stepFirstTokenTime !== undefined ? completedTime - stepFirstTokenTime : 0
        if (decodeWindow >= MIN_DECODE_MS && stepUsage?.outputTokens !== undefined) {
          decodeMs += decodeWindow
          decodedTokens += stepUsage.outputTokens
        }

        if (parts.length) {
          this.ctx.sessions.append(sessionId, 'message/assistant', {
            id: messageId,
            parts,
            at: completedTime,
            // A step cut mid-stream keeps its partial output for the transcript
            // but is marked so neither the next request nor the UI treats the
            // fragment as a complete answer.
            ...(aborted ? { interrupted: true } : {}),
            ...(stepUsage ? { usage: stepUsage } : {}),
            timing,
          })
        }

        // A stopped step ends the turn: its tool-call arguments may be
        // truncated, so acting on them would run an incomplete plan.
        if (aborted) {
          reason = 'stopped'
          break
        }

        if (calls.length) {
          // Record the decision point, not just its outcome: the tools that
          // were reachable and the ones the model picked. Without the
          // available set a replay cannot tell a deliberate choice from the
          // only option.
          this.ctx.sessions.append(sessionId, 'agent/decision', {
            chosen: calls.map(call => call.name),
            available: this.toolsFor(mode, options.denyTools, sessionId).map(tool => tool.name).slice(0, 200),
            at: completedTime,
          })
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
          // Deterministic gate: a turn may not finish with unbaselined errors.
          // Feedback is persisted so the diagnostics survive a reload.
          const hooks = this.ctx.get('hooks', false) as
            | {
              beforeStop(sessionId: string): Promise<{ blocked: boolean; feedback?: string }>
              beforeDeliver?(sessionId: string): Promise<{ blocked: boolean; feedback?: string }>
            }
            | undefined
          if (hooks && !controller.signal.aborted) {
            try {
              const gate = await hooks.beforeStop(sessionId)
              if (gate.blocked && gate.feedback) {
                this.ctx.sessions.append(sessionId, 'message/user', {
                  id: randomUUID(),
                  text: gate.feedback,
                  at: Date.now(),
                  source: { kind: 'hook', name: 'stop', forMessageId: messageId },
                })
                continue
              }
              // Delivery gate runs after the code gate: a build error should be
              // reported before a missing acceptance item.
              const delivery = await hooks.beforeDeliver?.(sessionId)
              if (delivery?.blocked && delivery.feedback) {
                this.ctx.sessions.append(sessionId, 'message/user', {
                  id: randomUUID(),
                  text: delivery.feedback,
                  at: Date.now(),
                  source: { kind: 'hook', name: 'deliver', forMessageId: messageId },
                })
                continue
              }
            } catch (error) {
              this.ctx.logger('agent').warn('gate failed: %s',
                error instanceof Error ? error.message : String(error))
            }
          }

          reason = stop === 'aborted' || controller.signal.aborted ? 'stopped' : 'done'
          break
        }

        const executeCall = async (call: ToolCallPart) => {
          const args = parseArguments(call.arguments)
          const result = await this.ctx.tools.invoke(call.name, args, {
            signal: controller.signal,
            sessionId,
            callId: call.id,
            workspace: record.meta.workspace,
          })
          return { args, result }
        }

        // A blocking tool (for example a question to the human) must see the
        // step alone: a sibling acting first could change the state the answer
        // is about. It runs first and serial; the rest follow once it returns.
        const blocking = calls.filter(call => this.ctx.tools.get(call.name)?.blocksBatch === true)
        const ordered = blocking.length
          ? [...blocking, ...calls.filter(call => !blocking.includes(call))]
          : calls

        // Independent read-only calls from one model step run together; any
        // writer or approval stays serial so side effects keep their order.
        const readOnlyBatch = blocking.length === 0 && ordered.length > 1 && ordered.every((call) => {
          const tool = this.ctx.tools.get(call.name)
          return this.ctx.modes.allows(mode?.id, call.name)
            && tool?.readOnly === true
            && !tool.requiresApproval
        })
        const batch = readOnlyBatch && !controller.signal.aborted
          ? await Promise.all(ordered.map(executeCall))
          : undefined

        let goalComplete = false
        for (const [index, call] of ordered.entries()) {
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
          const { args, result } = batch ? batch[index]! : await executeCall(call)
          this.ctx.sessions.append(sessionId, 'tool/result', {
            callId: call.id,
            name: call.name,
            content: result.content,
            isError: result.isError,
            ...(result.images?.length ? { images: result.images } : {}),
          })
          // Edit-time gate: formatter + incremental lint, fed back before the
          // next step. Ephemeral by design; the stop gate is the persisted one.
          const hooks = this.ctx.get('hooks', false) as
            | {
              afterTool(
                call: { name: string; args: Record<string, unknown>; sessionId?: string },
                result: { isError?: boolean },
              ): Promise<{ feedback?: string }>
            }
            | undefined
          if (hooks) {
            try {
              const check = await hooks.afterTool(
                { name: call.name, args: args as Record<string, unknown>, sessionId },
                { isError: result.isError },
              )
              if (check.feedback) {
                extra.push({ role: 'user', content: [{ type: 'text', text: check.feedback }] })
              }
            } catch (error) {
              this.ctx.logger('agent').warn('edit hook failed: %s',
                error instanceof Error ? error.message : String(error))
            }
          }
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
          cachedInputTokens,
          cacheWriteInputTokens,
        } : {}),
        ...(firstDeltaAt !== undefined ? { ttftMs: firstDeltaAt - startedAt } : {}),
        ...(decodeMs ? { generationMs: decodeMs } : {}),
        ...(decodedTokens ? { streamedOutputTokens: decodedTokens } : {}),
        durationMs: Date.now() - startedAt,
        steps,
        outputChars,
      }
      this.ctx.emit('agent/usage', sessionId, stats)
    }
    return { reason, text: lastText }
  }

  /**
   * Fold messages queued during this turn into the log at a step boundary.
   *
   * Appending rather than stashing them for the next request keeps the rule
   * that everything the model sees is in the log; the chat projection turns
   * them into ordinary user rows.
   */
  private admitInterjections(sessionId: string) {
    const pending = this.interjections?.(sessionId)
    if (!pending?.length) return
    for (const message of pending) this.ctx.sessions.append(sessionId, 'message/user', message)
  }

  /**
   * Persist the shape of the context this turn's model request was built from.
   *
   * The trajectory renders it as a 上下文 record so a session can explain what
   * the model saw without storing (and duplicating) the prompt itself.
   */
  private recordContext(
    sessionId: string,
    built: { request: ModelRequest; estimatedTokens: number; divergence?: PrefixDivergence },
    mode: ModeDefinition | undefined,
  ) {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return
    const events = record.events
    const latest = (type: string) => [...events].reverse().find(event => event.type === type)
    const summary = latest('context/summary')
    const memory = latest('context/memory')
    const lastUser = [...events].reverse().find(event =>
      event.type === 'message/user' && !event.data?.source?.kind)
    const turns = events.filter(event =>
      event.type === 'message/user' && !event.data?.source?.kind).length
    const system = built.request.messages[0]
    const systemChars = system?.role === 'system'
      ? system.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0)
      : 0
    this.ctx.sessions.append(sessionId, 'context/snapshot', {
      at: Date.now(),
      step: 1,
      workspace: record.meta.workspace,
      provider: this.providerName(record),
      model: this.modelFor(record),
      mode: mode?.id ?? record.meta.mode,
      permission: record.meta.permission,
      messages: built.request.messages.length,
      tools: built.request.tools?.length ?? 0,
      turns,
      systemChars,
      estimatedTokens: built.estimatedTokens,
      ...(summary?.data?.upToSeq !== undefined ? { summaryUpToSeq: summary.data.upToSeq } : {}),
      ...(memory?.data?.upToSeq !== undefined ? { memoryUpToSeq: memory.data.upToSeq } : {}),
      ...(built.divergence ? { cacheBreak: built.divergence } : {}),
      focus: String(lastUser?.data?.text ?? '').replace(/\s+/g, ' ').slice(0, 200),
    })
  }

  private async request(
    sessionId: string,
    signal: AbortSignal,
    mode: ModeDefinition | undefined,
    extra: Message[],
    denyTools?: string[],
  ): Promise<{ request: ModelRequest; estimatedTokens: number; divergence?: PrefixDivergence }> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const tools = this.toolsFor(mode, denyTools, sessionId)
    const built = await this.ctx.context.build(sessionId, {
      basePrompt: this.config.systemPrompt,
      modePrompt: mode?.systemPrompt,
      extraMessages: extra,
      tools,
      record: true,
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
        // A stable routing identity: sessions that render the same tools and
        // system share a cache bucket, and forked sub-agents inherit it.
        cache: {
          key: `${this.providerName(record)}|${this.modelFor(record)}|${built.cacheKey}`,
        },
      },
      estimatedTokens: built.estimatedTokens,
      ...(built.divergence ? { divergence: built.divergence } : {}),
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
      event.type === 'message/user' && !event.data?.source?.kind)
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
      event.type === 'message/user' && !event.data?.source?.kind)
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

  /**
   * The tool catalog for one request. Deferred integration tools stay out
   * until `tool_search` opens them for this session, or until the mode names
   * them itself (Ask/Plan list the read-only Gitee tools, Goal adds its
   * completion tool). Permission presets still do not filter the offered set:
   * it renders at position zero of the prompt, so a per-request filter would
   * void the cache. The registry refuses a disallowed call and approval
   * decides the rest.
   */
  private toolsFor(mode: ModeDefinition | undefined, denyTools: string[] | undefined, sessionId: string | undefined) {
    return this.ctx.tools.offered(sessionId, {
      allow: name => this.ctx.modes.allows(mode?.id, name),
      includeDeferred: name => this.ctx.modes.explicit(mode?.id, name),
      deny: denyTools,
    })
  }

  /**
   * Load a domain's tools on demand. The schema is small; the payoff is that
   * Forge, wiki, memory, contract and delivery tools no longer render in
   * every step of a coding task.
   */
  private searchTool(): ToolDefinition {
    return {
      name: 'tool_search',
      description: [
        'Load tools that are not in the current tool set.',
        'Search by tool name, group prefix or an English keyword:',
        'gitee (repositories, issues, pull requests, releases), wiki (knowledge base),',
        'memory (long-term memory), contract (acceptance contract), delivery (handoff),',
        'plan (submit a plan), browser (resize/close), skill (propose a skill).',
        'Matching tools become available on the next step of this turn. Chinese keywords',
        'such as 仓库/问题/知识库/记忆/契约/交付/计划/浏览器 are also matched.',
      ].join(' '),
      readOnly: true,
      // Its result decides what the next step should call; run it before any
      // sibling so the step's intent is not split across two turns.
      blocksBatch: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Tool name, group prefix, or keyword, e.g. "gitee issue".' },
        },
        required: ['query'],
      },
      execute: (args, run) => {
        const query = String(args?.query ?? '').trim()
        const record = run.sessionId ? this.ctx.sessions.get(run.sessionId) : undefined
        const modeId = record?.meta.mode
        const matches = this.ctx.tools.searchDeferred(query, name => this.ctx.modes.allows(modeId, name))
        if (!matches.length) {
          const groups = [...new Set(this.ctx.tools.searchDeferred('')
            .map(tool => tool.name.split('_')[0]))].sort()
          return `No matching tools for "${query}". Available groups: ${groups.join(', ')}.`
        }
        const opened = this.ctx.tools.activate(run.sessionId, matches.map(tool => tool.name))
        const names = matches.map(tool => tool.name).join(', ')
        if (!run.sessionId) return `Matching tools: ${names}.`
        return opened.length
          ? `Activated: ${opened.join(', ')}. They are available from the next step.`
          : `${names} are already available.`
      },
    }
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
