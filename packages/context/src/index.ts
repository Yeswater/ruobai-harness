import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ContentPart, Message, ToolSchema } from '@ruobai/llm'
import type { SessionEvent, SessionRecord } from '@ruobai/session'
import type {} from '@ruobai/workspace'
import { globalRuobaiDir, instructionsSignature, loadInstructions, type InstructionFile } from './instructions.ts'
import {
  DEFAULT_PRUNE,
  SUMMARY_EVENT,
  SUMMARY_PREAMBLE,
  SUMMARY_SYSTEM,
  estimateTextTokens,
  eventTokens,
  extractSummary,
  isContextOverflow,
  pruneToolResults,
  renderTranscript,
  selectCompactionCut,
  summaryInstruction,
  type CompactionSelection,
  type PruneConfig,
} from './compaction.ts'

export * from './compaction.ts'
export { globalRuobaiDir, discoverInstructionFiles, loadInstructions } from './instructions.ts'
export type { InstructionFile } from './instructions.ts'

export interface Config {
  /** Estimated tokens that trigger summarization when no window is known. */
  compactAt?: number
  /** Events kept verbatim after a summary. */
  keepRecent?: number
  /** Maximum characters of workspace instruction files to include. */
  maxInstructions?: number
  /** User-global protocol directory; defaults to ~/.ruobai. */
  globalRoot?: string
  /** Largest instruction file read from disk. */
  maxSourceBytes?: number
  /** How long a rendered instruction set is reused. */
  instructionsTtlMs?: number
  /** Recent tail kept verbatim, as a percentage of the model window. */
  retainPercent?: number
  /** Absolute recent-tail budget; overrides `retainPercent`. */
  retainTokens?: number
  /** Projection-time head/tail pruning of old tool output. */
  pruneToolResults?: boolean
  pruneKeepRecent?: number
  pruneThreshold?: number
  pruneHead?: number
  pruneTail?: number
  /** Extra summarization attempts when a summary does not shrink the context. */
  compactionRetries?: number
}

export interface BuildOptions {
  basePrompt?: string
  modePrompt?: string
  extraMessages?: Message[]
  tools?: ToolSchema[]
}

export interface BuiltContext {
  system: string
  messages: Message[]
  estimatedTokens: number
}

export interface ContextInfo {
  estimatedTokens: number
  compactAt: number
  summaries: number
  /** Configured model context window, when the provider settings define one. */
  contextWindow?: number
  /** Estimated token size of each prompt region; they sum to `estimatedTokens`. */
  breakdown: {
    messages: number
    systemPrompt: number
    systemTools: number
    mcpTools: number
  }
  /** Names of the MCP tools currently exposed to the model. */
  mcpTools: string[]
  /** Estimated/actual ratio learned from provider usage; 1 means uncalibrated. */
  calibration: number
  /** Tool results currently pruned from the model view. */
  prunedToolResults: number
  compaction: {
    failures: number
    disabled: boolean
    lastError?: string
    lastAt?: number
    lastBefore?: number
    lastAfter?: number
  }
}

export interface CompactOptions extends BuildOptions {
  provider?: string
  model?: string
  signal?: AbortSignal
  /** Optional manual-compaction focus from `/compact <focus>`. */
  focus?: string
}

export type CompactionTrigger = 'auto' | 'manual' | 'overflow'

export interface CompactionInfo {
  sessionId: string
  upToSeq: number
  before: number
  after: number
  trigger: CompactionTrigger
  summaryTokens: number
}

export interface CompactionFailure {
  sessionId: string
  trigger: CompactionTrigger
  message: string
  failures: number
}

declare module '@ruobai/cordis' {
  interface Context {
    context: ContextService
  }

  interface Events {
    'context/compacted'(info: CompactionInfo): void
    'context/compaction-start'(info: { sessionId: string; trigger: CompactionTrigger }): void
    'context/compaction-failed'(info: CompactionFailure): void
  }
}

interface InstructionCache {
  at: number
  signature: string
  text: string
  files: InstructionFile[]
  truncated: boolean
}

interface CompactionState {
  running: boolean
  failures: number
  disabled: boolean
  lastError?: string
  lastAt?: number
  lastBefore?: number
  lastAfter?: number
}

/** Consecutive failures after which automatic compaction stands down. */
const MAX_CONSECUTIVE_FAILURES = 3

/** A summary must remove at least this fraction of the prompt to count. */
const MIN_SHRINK_RATIO = 0.9

/**
 * Builds the model-facing context and compacts old history.
 *
 * Compaction is tiered: old tool output is pruned at projection time (no
 * model call), then a structured checkpoint replaces the older conversation
 * when the estimate crosses the model's threshold. The raw log is never
 * rewritten, so the transcript and replay stay intact.
 */
export class ContextService extends Service {
  static inject = ['sessions', 'llm']

  static Config: z<Config> = z.object({
    compactAt: z.number().min(1).default(48_000),
    keepRecent: z.number().min(2).default(12),
    maxInstructions: z.number().min(0).default(16_000),
    globalRoot: z.string(),
    maxSourceBytes: z.number().min(1).default(1_048_576),
    instructionsTtlMs: z.number().min(0).default(5_000),
    retainPercent: z.number().min(1).max(90).default(16),
    retainTokens: z.number().min(20),
    pruneToolResults: z.boolean().default(true),
    pruneKeepRecent: z.number().min(0).default(DEFAULT_PRUNE.keepRecent),
    pruneThreshold: z.number().min(100).default(DEFAULT_PRUNE.thresholdChars),
    pruneHead: z.number().min(0).default(DEFAULT_PRUNE.headChars),
    pruneTail: z.number().min(0).default(DEFAULT_PRUNE.tailChars),
    compactionRetries: z.number().min(0).max(3).default(1),
  })

  private instructions = new Map<string, InstructionCache>()
  /** Inputs of the last agent build, reused to explain the context size. */
  private lastOptions = new Map<string, BuildOptions>()
  private compactionStates = new Map<string, CompactionState>()
  /** Estimated/actual ratio learned from provider-reported input tokens. */
  private calibration = new Map<string, number>()
  /** Sessions whose log changed since the last projection prune audit. */
  private prunedCounts = new Map<string, number>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'context')
  }

  async build(sessionId: string, options: BuildOptions = {}): Promise<BuiltContext> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const summary = latestSummary(record)
    const instructions = await this.workspaceInstructions(sessionId)
    const skills = await this.skillsCatalog(sessionId)
    const system = [
      options.basePrompt,
      options.modePrompt,
      instructions,
      skills,
      summary ? renderSummary(summary.text) : undefined,
    ].filter(Boolean).join('\n\n')

    const visible = record.events.filter(event => event.seq > (summary?.upToSeq ?? -1))
    const pruned = pruneToolResults(visible, this.pruneConfig())
    this.prunedCounts.set(sessionId, pruned.size)

    const messages: Message[] = []
    for (const event of record.events) {
      if (event.seq <= (summary?.upToSeq ?? -1)) continue
      messages.push(...toMessages(event, pruned))
    }
    if (options.extraMessages?.length) messages.push(...options.extraMessages)

    if (options.tools !== undefined) {
      this.lastOptions.set(sessionId, {
        basePrompt: options.basePrompt,
        modePrompt: options.modePrompt,
        tools: options.tools,
      })
    }

    return {
      system,
      messages,
      estimatedTokens: estimate(system, messages, options.tools, this.factor(sessionId)),
    }
  }

  async info(sessionId: string): Promise<ContextInfo> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)
    const cached = this.lastOptions.get(sessionId)
    const agent = this.ctx.get('agents', false) as { config?: { systemPrompt?: string } } | undefined
    const modes = this.ctx.get('modes', false) as {
      get(id?: string): { systemPrompt?: string } | undefined
      allows(id: string | undefined, tool: string): boolean
    } | undefined
    const modeId = record.meta.mode
    const registry = this.ctx.get('tools', false) as {
      list(): ToolSchema[]
      get(name: string): unknown
    } | undefined
    const permissions = this.ctx.get('permissions', false) as
      | { allowsTool(sessionId: string | undefined, tool: unknown): boolean }
      | undefined
    const tools = cached?.tools
      ?? registry?.list()?.filter(tool =>
        (modes?.allows(modeId, tool.name) ?? true)
        && (!permissions || permissions.allowsTool(sessionId, registry.get(tool.name))))
      ?? []
    const built = await this.build(sessionId, {
      basePrompt: cached?.basePrompt ?? agent?.config?.systemPrompt,
      modePrompt: cached?.modePrompt ?? modes?.get(modeId)?.systemPrompt,
    })
    const factor = this.factor(sessionId)
    const mcp = tools.filter(tool => tool.name.startsWith('mcp__'))
    const regular = tools.filter(tool => !tool.name.startsWith('mcp__'))
    const breakdown = {
      messages: estimateMessages(built.messages, factor),
      systemPrompt: estimateText(built.system, factor),
      systemTools: estimateSchema(regular, factor),
      mcpTools: estimateSchema(mcp, factor),
    }
    const model = this.modelInfo(record)
    const state = this.state(sessionId)
    return {
      estimatedTokens: breakdown.messages + breakdown.systemPrompt
        + breakdown.systemTools + breakdown.mcpTools,
      compactAt: this.threshold(sessionId),
      ...(model?.contextWindow ? { contextWindow: model.contextWindow } : {}),
      summaries: record.events.filter(event => event.type === SUMMARY_EVENT).length,
      breakdown,
      mcpTools: mcp.map(tool => tool.name),
      calibration: Number(factor.toFixed(3)),
      prunedToolResults: this.prunedCounts.get(sessionId) ?? 0,
      compaction: {
        failures: state.failures,
        disabled: state.disabled,
        ...(state.lastError ? { lastError: state.lastError } : {}),
        ...(state.lastAt ? { lastAt: state.lastAt } : {}),
        ...(state.lastBefore ? { lastBefore: state.lastBefore } : {}),
        ...(state.lastAfter ? { lastAfter: state.lastAfter } : {}),
      },
    }
  }

  /** Summarize older events when the estimate crosses the threshold. */
  async maybeCompact(sessionId: string, options: CompactOptions = {}): Promise<CompactionInfo | undefined> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return
    const state = this.state(sessionId)
    if (state.running || state.disabled) return
    const built = await this.build(sessionId, options)
    if (built.estimatedTokens < this.threshold(sessionId)) return
    return this.compact(sessionId, options, 'auto', built.estimatedTokens)
  }

  /** Explicit `/compact`: summarize useful history even below the threshold. */
  async compactNow(sessionId: string, options: CompactOptions = {}): Promise<CompactionInfo | undefined> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)
    if (this.state(sessionId).running) throw new Error('compaction is already running')
    const built = await this.build(sessionId, options)
    return this.compact(sessionId, options, 'manual', built.estimatedTokens)
  }

  /** Provider-confirmed overflow: force a reduction regardless of threshold. */
  async forceCompact(sessionId: string, options: CompactOptions = {}): Promise<CompactionInfo | undefined> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return
    if (this.state(sessionId).running) return
    const built = await this.build(sessionId, options)
    return this.compact(sessionId, options, 'overflow', built.estimatedTokens)
  }

  /**
   * Fold the estimated/actual ratio of one completed request into this
   * session's calibration. Provider counts include system, messages and tools.
   */
  observeUsage(sessionId: string, estimated: number, actualInputTokens: number) {
    if (!Number.isFinite(estimated) || estimated <= 0) return
    if (!Number.isFinite(actualInputTokens) || actualInputTokens <= 0) return
    const sample = Math.min(2, Math.max(0.5, actualInputTokens / estimated))
    const previous = this.calibration.get(sessionId) ?? 1
    this.calibration.set(sessionId, Math.min(2, Math.max(0.5, previous * 0.4 + sample * 0.6)))
  }

  private async compact(
    sessionId: string,
    options: CompactOptions,
    trigger: CompactionTrigger,
    before: number,
  ): Promise<CompactionInfo | undefined> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return
    const state = this.state(sessionId)
    if (state.running) return
    state.running = true
    this.ctx.emit('context/compaction-start', { sessionId, trigger })

    let attempted = false
    try {
      const previous = latestSummary(record)
      const pruned = pruneToolResults(record.events, this.pruneConfig())
      const window = this.modelInfo(record)?.contextWindow
      const threshold = this.threshold(sessionId)
      // Never retain as much as the threshold itself: a 10%-window threshold
      // with the default 16% retention would otherwise compact on every step.
      const baseRetain = Math.min(
        this.config.retainTokens
          ?? (window
            ? Math.floor((window * (this.config.retainPercent ?? 16)) / 100)
            : Math.max(20, Math.floor(threshold * 0.25))),
        Math.max(20, Math.floor(threshold * 0.5)),
      )
      const attempts = Math.max(1, (this.config.compactionRetries ?? 1) + 1)
      let selection: CompactionSelection | null = null
      let summaryText = ''
      let projected = before

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const retained = Math.max(20, Math.floor(baseRetain * (1 / 2 ** attempt)))
        selection = selectCompactionCut(record.events, {
          upToSeq: previous?.upToSeq ?? -1,
          retainTokens: retained,
          keepRecent: this.config.keepRecent ?? 12,
          cost: event => eventTokens(event, pruned),
        })
        if (!selection) {
          if (!attempted) return
          break
        }
        attempted = true

        const cut = selection.upToSeq
        const source = record.events.filter(event =>
          event.seq > (previous?.upToSeq ?? -1) && event.seq <= cut)
        summaryText = await this.summarize(source, cut, pruned, options)

        const removed = source.reduce((total, event) => total + eventTokens(event, pruned), 0)
        projected = Math.max(0, before - removed) + estimateTextTokens(summaryText) + 64
        if (projected < before * MIN_SHRINK_RATIO) break
        // A summary that does not shrink the prompt is not useful; retry with
        // a deeper cut before giving up.
        selection = null
        summaryText = ''
      }

      if (!selection || !summaryText) {
        throw new Error(attempted
          ? 'summary did not shrink the context'
          : 'no compactable history')
      }

      const info: CompactionInfo = {
        sessionId,
        upToSeq: selection.upToSeq,
        before,
        after: projected,
        trigger,
        summaryTokens: estimateTextTokens(summaryText),
      }
      this.ctx.sessions.append(sessionId, SUMMARY_EVENT, {
        upToSeq: selection.upToSeq,
        text: summaryText,
        at: Date.now(),
        before,
        after: projected,
        trigger,
      })
      const rebuilt = await this.build(sessionId, options)
      info.after = rebuilt.estimatedTokens

      state.failures = 0
      state.disabled = false
      delete state.lastError
      state.lastAt = Date.now()
      state.lastBefore = info.before
      state.lastAfter = info.after
      this.ctx.emit('context/compacted', info)
      return info
    } catch (error) {
      if (options.signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      state.failures += 1
      state.lastError = message
      if (state.failures >= MAX_CONSECUTIVE_FAILURES) state.disabled = true
      this.ctx.logger('context').warn('compaction (%s) failed: %s', trigger, message)
      this.ctx.emit('context/compaction-failed', {
        sessionId,
        trigger,
        message,
        failures: state.failures,
      })
      return
    } finally {
      state.running = false
    }
  }

  /**
   * Ask the model for a checkpoint. If the checkpoint request itself exceeds
   * the window, drop the oldest quarter of the span and retry instead of
   * failing the turn.
   */
  private async summarize(
    source: SessionEvent[],
    cutSeq: number,
    pruned: Map<number, string>,
    options: CompactOptions,
  ): Promise<string> {
    const instruction = options.focus
      ? `${summaryInstruction()}\n\nFocus especially on: ${options.focus}`
      : summaryInstruction()
    let start = 0
    for (let round = 0; round < 4; round += 1) {
      const transcript = renderTranscript(source.slice(start), cutSeq, pruned)
      const response = await this.ctx.llm.complete({
        signal: options.signal,
        model: options.model,
        maxTokens: 4_096,
        messages: [
          { role: 'system', content: [{ type: 'text', text: SUMMARY_SYSTEM }] },
          { role: 'user', content: [{ type: 'text', text: `${transcript}\n\n${instruction}` }] },
        ],
      }, options.provider)
      if (!response.error) {
        const text = extractSummary(response.content)
        if (!text) throw new Error('summarizer returned no text')
        return text
      }
      if (!isContextOverflow(response.error)) throw new Error(response.error)
      const next = start + Math.max(1, Math.floor(source.length * 0.25))
      if (next >= source.length) throw new Error(response.error)
      start = next
    }
    throw new Error('summarizer could not fit the conversation')
  }

  private factor(sessionId: string) {
    return this.calibration.get(sessionId) ?? 1
  }

  private state(sessionId: string): CompactionState {
    let state = this.compactionStates.get(sessionId)
    if (!state) {
      state = { running: false, failures: 0, disabled: false }
      this.compactionStates.set(sessionId, state)
    }
    return state
  }

  private pruneConfig(): PruneConfig {
    return {
      enabled: this.config.pruneToolResults ?? DEFAULT_PRUNE.enabled,
      keepRecent: this.config.pruneKeepRecent ?? DEFAULT_PRUNE.keepRecent,
      thresholdChars: this.config.pruneThreshold ?? DEFAULT_PRUNE.thresholdChars,
      headChars: this.config.pruneHead ?? DEFAULT_PRUNE.headChars,
      tailChars: this.config.pruneTail ?? DEFAULT_PRUNE.tailChars,
    }
  }

  private threshold(sessionId?: string) {
    const settings = this.ctx.get('settings', false) as
      | { raw(): { agent?: { compactAt?: number; compactPercent?: number } } }
      | undefined
    const agent = settings?.raw().agent
    if (sessionId) {
      const record = this.ctx.sessions.get(sessionId)
      const window = record ? this.modelInfo(record)?.contextWindow : undefined
      if (window) {
        const percent = agent?.compactPercent ?? 80
        return Math.max(1_000, Math.floor((window * percent) / 100))
      }
    }
    return agent?.compactAt ?? this.config.compactAt ?? 48_000
  }

  /** Context window and capabilities configured for this session's model. */
  private modelInfo(record: SessionRecord) {
    const settings = this.ctx.get('settings', false) as
      | {
        raw?(): { llm?: { activeProvider?: string; activeModel?: string } }
        findProvider?(id: string): {
          models: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }>
        } | undefined
      }
      | undefined
    const config = settings?.raw?.()
    const providerId = record.meta.provider ?? config?.llm?.activeProvider
    const modelId = record.meta.model ?? config?.llm?.activeModel
    return providerId
      ? settings?.findProvider?.(providerId)?.models.find(item => item.id === modelId)
      : undefined
  }

  private instructionRoot(sessionId: string) {
    const workspace = this.ctx.get('workspace', false) as
      | { rootFor(id?: string | null): string }
      | undefined
    return workspace?.rootFor(sessionId) ?? process.cwd()
  }

  private async workspaceInstructions(sessionId: string) {
    const root = this.instructionRoot(sessionId)
    const config = {
      root,
      globalRoot: this.config.globalRoot ?? globalRuobaiDir(),
      maxSourceBytes: this.config.maxSourceBytes,
      maxInstructions: this.config.maxInstructions ?? 16_000,
    }
    const cached = this.instructions.get(root)
    const signature = await instructionsSignature(config)
    const ttl = this.config.instructionsTtlMs ?? 5_000
    if (cached && cached.signature === signature && Date.now() - cached.at < ttl) {
      return cached.text
    }
    const result = await loadInstructions(config)
    this.instructions.set(root, {
      at: Date.now(),
      signature,
      text: result.text,
      files: result.files,
      truncated: result.truncated,
    })
    return result.text
  }

  /** Read-only view of the instruction files merged into the system prompt. */
  async instructionInfo(sessionId: string) {
    await this.workspaceInstructions(sessionId)
    const root = this.instructionRoot(sessionId)
    const cached = this.instructions.get(root)
    return {
      root,
      files: (cached?.files ?? []).map(file => ({
        path: file.path,
        display: file.display,
        bytes: file.bytes,
      })),
      truncated: cached?.truncated ?? false,
    }
  }

  /** Skills are optional: a missing service simply contributes nothing. */
  private async skillsCatalog(sessionId: string) {
    const skills = this.ctx.get('skills', false) as
      | { catalog(sessionId?: string): Promise<string> }
      | undefined
    if (!skills) return ''
    try {
      return await skills.catalog(sessionId)
    } catch {
      return ''
    }
  }
}

export default ContextService

function latestSummary(record: SessionRecord): { upToSeq: number; text: string } | undefined {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index]!
    if (event.type === SUMMARY_EVENT) return event.data
  }
}

function renderSummary(text: string) {
  return `Summary of the earlier conversation:\n${SUMMARY_PREAMBLE}\n\n<compacted-summary>\n${text}\n</compacted-summary>`
}

function toMessages(event: SessionEvent, pruned: Map<number, string>): Message[] {
  if (event.type === 'message/user') {
    const parts: ContentPart[] = []
    if (event.data.text) parts.push({ type: 'text', text: event.data.text })
    const attachments = (event.data.attachments ?? []) as Array<{
      kind: 'image' | 'file'
      name: string
      mime: string
      data?: string
      text?: string
      path?: string
    }>
    for (const attachment of attachments) {
      if (attachment.kind === 'image' && attachment.data) {
        parts.push({ type: 'image', mimeType: attachment.mime, data: attachment.data, name: attachment.name })
      } else if (attachment.kind === 'file' && attachment.text !== undefined) {
        parts.push({
          type: 'file',
          name: attachment.name,
          ...(attachment.path ? { path: attachment.path } : {}),
          mimeType: attachment.mime,
          text: attachment.text,
        })
      }
    }
    return parts.length ? [{ role: 'user', content: parts }] : []
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
        content: pruned.get(event.seq) ?? event.data.content,
        isError: event.data.isError,
      }],
    }]
  }
  return []
}

function estimate(system: string, messages: Message[], tools: ToolSchema[] | undefined, factor: number) {
  let chars = system.length + messageChars(messages)
  if (tools?.length) chars += JSON.stringify(tools).length
  // Mixed CJK/Latin heuristic; surfaced in the UI as an approximation.
  return Math.ceil((chars / 3) * factor)
}

function messageChars(messages: Message[]) {
  let chars = 0
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'text') chars += part.text.length
      else if (part.type === 'tool-call') chars += part.name.length + part.arguments.length
      else if (part.type === 'tool-result') chars += part.content.length
      else if (part.type === 'file') chars += part.text.length
      // Images have no text length; use a documented token-equivalent constant.
      else if (part.type === 'image') chars += IMAGE_TOKEN_CHARS
    }
  }
  return chars
}

/** Rough per-image cost (2,000 tokens) expressed in the estimator's char scale. */
const IMAGE_TOKEN_CHARS = 2_000 * 3

function estimateText(text: string, factor: number) {
  return Math.ceil((text.length / 3) * factor)
}

function estimateMessages(messages: Message[], factor: number) {
  return Math.ceil((messageChars(messages) / 3) * factor)
}

function estimateSchema(tools: ToolSchema[], factor: number) {
  return tools.length ? Math.ceil((JSON.stringify(tools).length / 3) * factor) : 0
}

export const meta = {
  title: '上下文服务',
  description: '组装系统提示、消息历史、工具输出裁剪与压缩检查点。',
}
