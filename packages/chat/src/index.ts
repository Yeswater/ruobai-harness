import { Service, type Context } from '@ruobai/cordis'
import type {} from '@ruobai/agent'
import type { ContentPart } from '@ruobai/llm'
import { DEFAULT_PERMISSION, isPermissionMode } from '@ruobai/permissions'
import type { SessionEvent, SessionMeta } from '@ruobai/session'
import type {
  AttachmentMeta, ChatBlock, ChatEvent, ChatMessage, ChatSession, SessionSummary, TurnStats,
} from '@ruobai/chat-protocol'

export type * from '@ruobai/chat-protocol'

declare module '@ruobai/cordis' {
  interface Context {
    chat: ChatService
  }

  interface Events {
    'chat/event'(event: ChatEvent): void
  }
}

/** Event types the bridge folds into the browser-facing `ChatSession` model. */
const CONVERSATION_EVENTS = new Set([
  'message/user',
  'message/assistant',
  'tool/result',
  'turn/error',
  'turn/notice',
])

/**
 * Browser-facing projection over the session log and the agent runtime.
 *
 * `ctx.chat` is the stable HTTP/SSE contract; everything below it (events,
 * persistence, model calls, tools) is replaceable without touching the UI.
 */
export class ChatService extends Service {
  static inject = ['sessions', 'agents', 'llm', 'modes']

  private readonly sessions = new Map<string, ChatSession>()

  constructor(ctx: Context) {
    super(ctx, 'chat')

    ctx.on('session/created', (meta) => {
      if (meta.kind === 'subagent') return
      const session = this.ensure(meta.id)
      this.ctx.emit('chat/event', { type: 'session-created', session })
    })

    ctx.on('session/removed', (id) => {
      this.sessions.delete(id)
      this.ctx.emit('chat/event', { type: 'session-deleted', sessionId: id })
    })

    ctx.on('session/event', (id, event) => this.onSessionEvent(id, event))

    ctx.on('agent/step-start', (id, messageId) => {
      if (!this.visible(id)) return
      const session = this.ensure(id)
      if (!session.messages.some(message => message.id === messageId)) {
        session.messages.push({
          id: messageId,
          role: 'assistant',
          blocks: [],
          status: 'streaming',
          createdAt: Date.now(),
        })
      }
      session.streaming = true
      const message = session.messages.find(item => item.id === messageId)!
      this.ctx.emit('chat/event', { type: 'message-added', sessionId: id, message })
      this.touch(id, session)
    })

    ctx.on('agent/delta', (id, messageId, delta) => {
      if (!this.visible(id)) return
      const session = this.ensure(id)
      const message = session.messages.find(item => item.id === messageId)
      if (!message) return
      const last = message.blocks.at(-1)
      if (!last || last.type !== 'text') message.blocks.push({ type: 'text', text: delta })
      else last.text += delta
      this.ctx.emit('chat/event', { type: 'message-delta', sessionId: id, messageId, delta })
    })

    ctx.on('agent/reasoning', (id, messageId, delta) => {
      if (!this.visible(id)) return
      const session = this.ensure(id)
      const message = session.messages.find(item => item.id === messageId)
      if (!message) return
      const last = message.blocks.at(-1)
      if (!last || last.type !== 'reasoning') message.blocks.push({ type: 'reasoning', text: delta })
      else last.text += delta
      this.ctx.emit('chat/event', { type: 'message-reasoning', sessionId: id, messageId, delta })
    })

    ctx.on('agent/turn-end', (id) => {
      if (!this.visible(id)) return
      const session = this.ensure(id)
      session.streaming = false
      for (const message of session.messages) {
        if (message.status === 'streaming') message.status = 'done'
      }
      this.ctx.emit('chat/event', { type: 'message-done', sessionId: id, session })
      this.touch(id, session)
    })

  }

  list(): SessionSummary[] {
    return this.ctx.sessions.list()
      .filter(meta => meta.kind !== 'subagent')
      .map((meta) => {
      const session = this.ensure(meta.id)
      return {
        id: meta.id,
        title: meta.title,
        model: session.model,
        provider: session.provider,
        mode: session.mode,
        permission: session.permission,
        workspace: session.workspace,
        archived: meta.archived ?? false,
        updatedAt: meta.updatedAt,
        messageCount: session.messages.length,
        streaming: session.streaming,
      }
    })
  }

  get(id: string): ChatSession | undefined {
    return this.ctx.sessions.has(id) ? this.ensure(id) : undefined
  }

  create(title?: string, mode?: string, workspace?: string): ChatSession {
    const settings = this.ctx.get('settings', false) as
      | {
        raw(): {
          llm?: { activeProvider?: string; activeModel?: string }
          agent?: { defaultMode?: string; defaultPermission?: unknown }
        }
      }
      | undefined
    const config = settings?.raw()
    const provider = config?.llm?.activeProvider ?? this.ctx.llm.config.provider
    const model = config?.llm?.activeModel
      ?? (provider === 'mock' || !provider ? this.ctx.llm.config.model : undefined)
    const requested = mode ?? config?.agent?.defaultMode
    const resolvedMode = requested && this.ctx.modes.get(requested)
      ? requested
      : this.ctx.modes.defaultId()
    const requestedPermission = config?.agent?.defaultPermission
    const permission = isPermissionMode(requestedPermission) && requestedPermission !== 'full-access'
      ? requestedPermission
      : undefined
    const meta = this.ctx.sessions.create({
      title,
      model,
      provider,
      mode: resolvedMode,
      workspace,
      ...(permission ? { permission } : {}),
    })
    return this.ensure(meta.id)
  }

  setMode(id: string, mode: string): ChatSession {
    if (!this.ctx.modes.get(mode)) throw new Error(`unknown mode: ${mode}`)
    this.ctx.sessions.setMode(id, mode)
    const session = this.ensure(id)
    session.mode = mode
    this.ctx.emit('chat/event', { type: 'session-updated', session })
    return session
  }

  setArchived(id: string, archived: boolean): ChatSession {
    this.ctx.sessions.setArchived(id, archived)
    const session = this.ensure(id)
    this.syncMeta(session)
    this.ctx.emit('chat/event', { type: 'session-updated', session })
    return session
  }

  setPermission(id: string, mode: string, confirm = false): ChatSession {
    if (!isPermissionMode(mode)) throw new Error(`unknown permission mode: ${mode}`)
    if (mode === 'full-access' && !confirm) throw new Error('full access requires confirmation')
    this.ctx.sessions.setPermission(id, mode)
    const session = this.ensure(id)
    this.syncMeta(session)
    this.ctx.emit('chat/event', { type: 'session-updated', session })
    return session
  }

  setModel(id: string, provider: string, model: string): ChatSession {
    const nextProvider = provider.trim()
    const nextModel = model.trim()
    if (!nextProvider || !nextModel) throw new Error('provider and model are required')
    const registered = this.ctx.llm.get(nextProvider)
    if (!registered) throw new Error(`unknown provider: ${nextProvider}`)
    const settings = this.ctx.get('settings', false) as
      | { findProvider?(id: string): { models: Array<{ id: string }> } | undefined }
      | undefined
    const configured = settings?.findProvider?.(nextProvider)?.models.map(model => model.id) ?? []
    const allowed = configured.length ? configured : registered.models ?? []
    if (allowed.length && !allowed.includes(nextModel)) {
      throw new Error(`model "${nextModel}" is not available for provider "${nextProvider}"`)
    }
    this.ctx.sessions.setModel(id, nextProvider, nextModel)
    const session = this.ensure(id)
    this.syncMeta(session)
    this.ctx.emit('chat/event', { type: 'session-updated', session })
    return session
  }

  rename(id: string, title: string): ChatSession {
    const next = title.trim()
    if (!next) throw new Error('title is required')
    if (next.length > 120) throw new Error('title is too long')
    this.ctx.sessions.rename(id, next)
    const session = this.ensure(id)
    this.syncMeta(session)
    return session
  }

  /** Abort a running turn before dropping the session and its log. */
  remove(id: string) {
    if (!this.ctx.sessions.has(id)) throw new Error(`unknown session: ${id}`)
    this.ctx.agents.stop(id)
    this.ctx.sessions.remove(id)
  }

  fork(id: string, upToSeq?: number): ChatSession {
    // A live turn may have a tool call without its result yet; copying that
    // slice would leave the fork with an unanswerable call.
    if (this.ctx.agents.isRunning(id)) throw new Error('session is running')
    const meta = this.ctx.sessions.fork(id, { upToSeq })
    return this.ensure(meta.id)
  }

  send(id: string, text: string, attachments: AttachmentMeta[] = []): ChatMessage {
    const user = this.ctx.agents.prompt(id, text, attachments)
    const session = this.ensure(id)
    return session.messages.find(message => message.id === user.id) ?? {
      id: user.id,
      role: 'user',
      blocks: [
        ...(user.text ? [{ type: 'text' as const, text: user.text }] : []),
        ...(user.attachments ?? []).map(attachment => ({ type: 'attachment' as const, attachment })),
      ],
      status: 'done',
      createdAt: user.at,
    }
  }

  stop(id: string) {
    this.ctx.agents.stop(id)
  }

  private ensure(id: string): ChatSession {
    const cached = this.sessions.get(id)
    if (cached) return cached
    const record = this.ctx.sessions.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)

    const session: ChatSession = {
      id,
      title: record.meta.title,
      model: record.meta.model ?? this.ctx.llm.config.model ?? 'unknown',
      provider: record.meta.provider,
      mode: record.meta.mode ?? this.ctx.modes.defaultId(),
      permission: this.permissionFor(id),
      workspace: record.meta.workspace,
      archived: record.meta.archived ?? false,
      createdAt: record.meta.createdAt,
      updatedAt: record.meta.updatedAt,
      messages: [],
      streaming: this.ctx.agents.isRunning(id),
    }
    for (const event of record.events) this.apply(session, event)
    this.sessions.set(id, session)
    return session
  }

  private visible(id: string) {
    const meta = this.ctx.sessions.get(id)?.meta
    return Boolean(meta) && meta!.kind !== 'subagent'
  }

  private onSessionEvent(id: string, event: SessionEvent) {
    if (!this.visible(id)) return
    if (!CONVERSATION_EVENTS.has(event.type)) {
      if (event.type === 'session/title' || event.type === 'session/meta') {
        const session = this.ensure(id)
        this.syncMeta(session)
        this.ctx.emit('chat/event', { type: 'session-updated', session })
      }
      return
    }

    const session = this.ensure(id)
    this.apply(session, event)

    if (event.type === 'message/user') {
      const message = session.messages.find(item => item.id === event.data.id)
      if (message) this.ctx.emit('chat/event', { type: 'message-added', sessionId: id, message })
      // A user turn opens a fresh stats window; publish the empty fold so the
      // strip stops showing the previous turn's numbers.
      if (event.data.source?.kind !== 'skill') {
        this.ctx.emit('chat/event', { type: 'session-stats', sessionId: id })
      }
    } else if (event.type === 'turn/error') {
      const message = session.messages.find(item => item.id === `error-${event.seq}`)
      if (message) this.ctx.emit('chat/event', { type: 'message-added', sessionId: id, message })
    } else if (event.type === 'turn/notice') {
      const message = session.messages.find(item => item.id === `notice-${event.seq}`)
      if (message) this.ctx.emit('chat/event', { type: 'message-added', sessionId: id, message })
    } else if (event.type === 'message/assistant') {
      const message = session.messages.find(item => item.id === event.data.id)
      if (message) this.ctx.emit('chat/event', { type: 'message-updated', sessionId: id, message })
      // Steps arrive one by one; republish the fold so partial turns read live.
      if (session.stats) this.ctx.emit('chat/event', { type: 'session-stats', sessionId: id, stats: session.stats })
    } else if (event.type === 'tool/result') {
      const message = session.messages.find(item => item.blocks.some(block =>
        block.type === 'tool' && block.callId === event.data.callId))
      if (message) this.ctx.emit('chat/event', { type: 'message-updated', sessionId: id, message })
    }

    this.touch(id, session)
  }

  private apply(session: ChatSession, event: SessionEvent) {
    if (event.type === 'message/user') {
      // Skill bodies are injected for the model only; the user's `/name` message
      // is the visible half of the gesture.
      if (event.data.source?.kind === 'skill') {
        session.updatedAt = Math.max(session.updatedAt, event.ts)
        return
      }
      // A user turn opens a new stats window. Folding from the log (rather than
      // from a live event) is what keeps the readings after a reload.
      session.stats = undefined
      if (!session.messages.some(message => message.id === event.data.id)) {
        const blocks: ChatBlock[] = []
        if (event.data.text) blocks.push({ type: 'text', text: event.data.text })
        for (const attachment of (event.data.attachments ?? []) as AttachmentMeta[]) {
          blocks.push({ type: 'attachment', attachment })
        }
        session.messages.push({
          id: event.data.id,
          role: 'user',
          blocks,
          status: 'done',
          createdAt: event.data.at ?? event.ts,
        })
      }
    } else if (event.type === 'message/assistant') {
      session.stats = foldStats(session.stats, event.data)
      const blocks = blocksOf(event.data.parts as ContentPart[])
      const existing = session.messages.find(message => message.id === event.data.id)
      if (existing) {
        existing.blocks = blocks
        existing.status = 'done'
      } else {
        session.messages.push({
          id: event.data.id,
          role: 'assistant',
          blocks,
          status: 'done',
          createdAt: event.data.at ?? event.ts,
        })
      }
    } else if (event.type === 'tool/result') {
      for (const message of session.messages) {
        const block = message.blocks.find(item =>
          item.type === 'tool' && item.callId === event.data.callId)
        if (block && block.type === 'tool') {
          block.output = event.data.content
          block.isError = Boolean(event.data.isError)
          break
        }
      }
    } else if (event.type === 'turn/error') {
      const id = `error-${event.seq}`
      if (!session.messages.some(message => message.id === id)) {
        session.messages.push({
          id,
          role: 'assistant',
          blocks: [{ type: 'text', text: `⚠ ${event.data.message}` }],
          status: 'done',
          createdAt: event.ts,
        })
      }
    } else if (event.type === 'turn/notice') {
      const id = `notice-${event.seq}`
      if (!session.messages.some(message => message.id === id)) {
        session.messages.push({
          id,
          role: 'assistant',
          blocks: [{ type: 'text', text: noticeText(event.data) }],
          status: 'done',
          createdAt: event.ts,
        })
      }
    }
    session.updatedAt = Math.max(session.updatedAt, event.ts)
  }

  private syncMeta(session: ChatSession) {
    const meta = this.ctx.sessions.get(session.id)?.meta
    if (!meta) return
    session.title = meta.title
    session.model = meta.model ?? session.model
    session.provider = meta.provider ?? session.provider
    session.mode = meta.mode ?? session.mode
    session.permission = this.permissionFor(session.id)
    session.workspace = meta.workspace ?? session.workspace
    session.archived = meta.archived ?? false
    session.updatedAt = meta.updatedAt
  }

  private permissionFor(id: string): string {
    const meta = this.ctx.sessions.get(id)?.meta
    if (isPermissionMode(meta?.permission)) return meta.permission
    const settings = this.ctx.get('settings', false) as
      | { raw(): { agent?: { defaultPermission?: unknown } } }
      | undefined
    const fallback = settings?.raw().agent?.defaultPermission
    if (isPermissionMode(fallback) && fallback !== 'full-access') return fallback
    return DEFAULT_PERMISSION
  }

  private touch(id: string, session: ChatSession) {
    const meta = this.ctx.sessions.get(id)?.meta
    if (meta) session.updatedAt = meta.updatedAt
    this.ctx.emit('chat/event', { type: 'session-updated', session })
  }
}

/** One step's persisted billing and timing, as written by the agent. */
interface StepRecord {
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    cacheWriteInputTokens?: number
  }
  timing?: {
    stepStartTime?: number
    firstTokenTime?: number
    completedTime?: number
  }
}

/**
 * Fold one assistant message into the turn's stats.
 *
 * Billing is summed over every step; the decode window and the tokens decoded
 * inside it are summed only over steps that reported both, so throughput never
 * divides a total by a partial window. TTFT is the first step that streamed.
 */
function foldStats(previous: TurnStats | undefined, data: StepRecord): TurnStats | undefined {
  const usage = data.usage
  const timing = data.timing
  if (!usage && !timing) return previous
  const stats: TurnStats = { ...(previous ?? {}) }

  if (usage) {
    stats.inputTokens = (stats.inputTokens ?? 0) + (usage.inputTokens ?? 0)
    stats.cachedInputTokens = (stats.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0)
    stats.cacheWriteInputTokens = (stats.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0)
    stats.outputTokens = (stats.outputTokens ?? 0) + (usage.outputTokens ?? 0)
  }

  const first = timing?.firstTokenTime
  const completed = timing?.completedTime
  if (first !== undefined && timing?.stepStartTime !== undefined && stats.ttftMs === undefined) {
    stats.ttftMs = Math.max(0, first - timing.stepStartTime)
  }
  if (first !== undefined && completed !== undefined && usage?.outputTokens !== undefined) {
    stats.generationMs = (stats.generationMs ?? 0) + Math.max(0, completed - first)
    stats.streamedOutputTokens = (stats.streamedOutputTokens ?? 0) + usage.outputTokens
  }
  stats.steps = (stats.steps ?? 0) + 1
  return stats
}

function blocksOf(parts: ContentPart[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'reasoning') blocks.push({ type: 'reasoning', text: part.text })
    else if (part.type === 'tool-call') {
      blocks.push({ type: 'tool', callId: part.id, name: part.name, input: part.arguments, output: '' })
    }
  }
  return blocks
}

function noticeText(data: { kind?: string; steps?: number; before?: number; after?: number; trigger?: string }) {
  if (data.kind === 'max-steps') {
    return `⚠ 本轮已达到 ${data.steps ?? 0} 步上限，任务可能还没完成。发送「继续」可以接着执行。`
  }
  if (data.kind === 'compacted') {
    const source = data.trigger === 'manual' ? '手动' : data.trigger === 'overflow' ? '溢出恢复' : '自动'
    const before = data.before !== undefined ? formatTokens(data.before) : '?'
    const after = data.after !== undefined ? formatTokens(data.after) : '?'
    return `上下文已压缩（${source}）：约 ${before} → ${after} tokens。`
  }
  if (data.kind === 'compact-empty') {
    return '没有可压缩的历史，或压缩未产生明显收益。'
  }
  return '⚠ 本轮已结束'
}

function formatTokens(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(tokens)}`
}

export default ChatService

export const meta = {
  title: '会话投影',
  description: '为浏览器聚合会话消息与流式事件。',
}
