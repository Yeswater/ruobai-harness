import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ContentPart, Message, ToolSchema } from '@ruobai/llm'
import type { SessionEvent, SessionRecord } from '@ruobai/session'
import type {} from '@ruobai/workspace'

export interface Config {
  /** Estimated tokens that trigger summarization. */
  compactAt?: number
  /** Events kept verbatim after a summary. */
  keepRecent?: number
  /** Maximum characters of workspace instruction files to include. */
  maxInstructions?: number
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
}

export interface CompactOptions extends BuildOptions {
  provider?: string
  model?: string
  signal?: AbortSignal
}

export interface CompactionInfo {
  sessionId: string
  upToSeq: number
  before: number
  after: number
}

declare module '@ruobai/cordis' {
  interface Context {
    context: ContextService
  }

  interface Events {
    'context/compacted'(info: CompactionInfo): void
  }
}

const SUMMARY_TYPE = 'context/summary'

/**
 * Builds the model-facing context and compacts old history with the LLM.
 *
 * A `context/summary` event replaces all earlier events in the request; the
 * raw log stays intact for replay and the UI.
 */
export class ContextService extends Service {
  static inject = ['sessions', 'llm']

  static Config: z<Config> = z.object({
    compactAt: z.number().min(1).default(48_000),
    keepRecent: z.number().min(2).default(12),
    maxInstructions: z.number().min(0).default(16_000),
  })

  private instructions?: { at: number; text: string }

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'context')
  }

  async build(sessionId: string, options: BuildOptions = {}): Promise<BuiltContext> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)

    const summary = latestSummary(record)
    const instructions = await this.workspaceInstructions()
    const system = [
      options.basePrompt,
      options.modePrompt,
      instructions,
      summary ? `Summary of the earlier conversation:\n${summary.text}` : undefined,
    ].filter(Boolean).join('\n\n')

    const messages: Message[] = []
    for (const event of record.events) {
      if (event.seq <= (summary?.upToSeq ?? -1)) continue
      messages.push(...toMessages(event))
    }
    if (options.extraMessages?.length) messages.push(...options.extraMessages)

    return {
      system,
      messages,
      estimatedTokens: estimate(system, messages, options.tools),
    }
  }

  async info(sessionId: string): Promise<ContextInfo> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) throw new Error(`unknown session: ${sessionId}`)
    const built = await this.build(sessionId)
    return {
      estimatedTokens: built.estimatedTokens,
      compactAt: this.threshold(),
      summaries: record.events.filter(event => event.type === SUMMARY_TYPE).length,
    }
  }

  /** Summarize older events when the estimate crosses the threshold. */
  async maybeCompact(sessionId: string, options: CompactOptions = {}): Promise<CompactionInfo | undefined> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return
    const built = await this.build(sessionId, options)
    const threshold = this.threshold()
    if (built.estimatedTokens < threshold) return

    const summary = latestSummary(record)
    const startSeq = (summary?.upToSeq ?? -1) + 1
    const events = record.events.filter(event => event.seq >= startSeq)
    const keep = this.config.keepRecent ?? 12
    if (events.length <= keep) return

    const cutSeq = events[events.length - keep - 1]!.seq
    const slice = events.filter(event => event.seq <= cutSeq)
    if (!slice.length) return

    const transcript = renderEvents(slice)
    const response = await this.ctx.llm.complete({
      signal: options.signal,
      model: options.model,
      messages: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: 'Summarize the conversation so far for another assistant. Preserve decisions, file paths, code changes, tool results, and open tasks. Be concise, under 1200 characters.',
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: `${summary ? `Previous summary:\n${summary.text}\n\n` : ''}${transcript}`,
          }],
        },
      ],
    }, options.provider)

    const text = response.content.trim()
    if (!text || response.error) return

    const info: CompactionInfo = {
      sessionId,
      upToSeq: cutSeq,
      before: built.estimatedTokens,
      after: 0,
    }
    this.ctx.sessions.append(sessionId, SUMMARY_TYPE, { upToSeq: cutSeq, text })
    const rebuilt = await this.build(sessionId, options)
    info.after = rebuilt.estimatedTokens
    this.ctx.emit('context/compacted', info)
    return info
  }

  private threshold() {
    const settings = this.ctx.get('settings', false) as
      | { raw(): { agent?: { compactAt?: number } } }
      | undefined
    return settings?.raw().agent?.compactAt ?? this.config.compactAt ?? 48_000
  }

  private async workspaceInstructions() {
    if (this.instructions && Date.now() - this.instructions.at < 5_000) return this.instructions.text
    const workspace = this.ctx.get('workspace', false) as
      | { read(path: string): Promise<{ content: string }> }
      | undefined
    if (!workspace) return ''

    const parts: string[] = []
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const file = await workspace.read(name)
        if (file.content.trim()) parts.push(`# ${name}\n${file.content.trim()}`)
      } catch {
        // missing instruction file
      }
    }

    const max = this.config.maxInstructions ?? 16_000
    let text = parts.join('\n\n')
    if (text.length > max) text = `${text.slice(0, max)}\n… (instructions truncated)`
    this.instructions = { at: Date.now(), text }
    return text
  }
}

export default ContextService

function latestSummary(record: SessionRecord): { upToSeq: number; text: string } | undefined {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index]!
    if (event.type === SUMMARY_TYPE) return event.data
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

function renderEvents(events: SessionEvent[]) {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === 'message/user') lines.push(`User: ${event.data.text}`)
    else if (event.type === 'message/assistant') {
      const parts = (event.data.parts as ContentPart[]).map(part => {
        if (part.type === 'text') return part.text
        if (part.type === 'tool-call') return `[tool ${part.name} ${part.arguments.slice(0, 300)}]`
        return ''
      }).filter(Boolean).join(' ')
      if (parts) lines.push(`Assistant: ${parts}`)
    } else if (event.type === 'tool/result') {
      lines.push(`Tool ${event.data.name}${event.data.isError ? ' (error)' : ''}: ${String(event.data.content).slice(0, 800)}`)
    }
  }
  return lines.join('\n\n')
}

function estimate(system: string, messages: Message[], tools?: ToolSchema[]) {
  let chars = system.length
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'text') chars += part.text.length
      else if (part.type === 'tool-call') chars += part.name.length + part.arguments.length
      else if (part.type === 'tool-result') chars += part.content.length
    }
  }
  if (tools?.length) chars += JSON.stringify(tools).length
  // Mixed CJK/Latin heuristic; surfaced in the UI as an approximation.
  return Math.ceil(chars / 3)
}
