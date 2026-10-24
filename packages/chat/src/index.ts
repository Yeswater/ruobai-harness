import { Service, type Context } from '@ruobai/cordis'
import type { ContentPart } from '@ruobai/llm'
import type { SessionEvent, SessionMeta } from '@ruobai/session'
import type { ChatBlock, ChatEvent, ChatMessage, ChatSession, SessionSummary } from '@ruobai/chat-protocol'

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
])

/**
 * Browser-facing projection over the session log and the agent runtime.
 *
 * `ctx.chat` is the stable HTTP/SSE contract; everything below it (events,
 * persistence, model calls, tools) is replaceable without touching the UI.
 */
export class ChatService extends Service {
  static inject = ['sessions', 'agents', 'llm']

  private readonly sessions = new Map<string, ChatSession>()

  constructor(ctx: Context) {
    super(ctx, 'chat')

    ctx.on('session/created', (meta) => {
      const session = this.ensure(meta.id)
      this.ctx.emit('chat/event', { type: 'session-created', session })
    })

    ctx.on('session/removed', (id) => {
      this.sessions.delete(id)
    })

    ctx.on('session/event', (id, event) => this.onSessionEvent(id, event))

    ctx.on('agent/step-start', (id, messageId) => {
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
      const session = this.ensure(id)
      const message = session.messages.find(item => item.id === messageId)
      if (!message) return
      const last = message.blocks.at(-1)
      if (!last || last.type !== 'text') message.blocks.push({ type: 'text', text: delta })
      else last.text += delta
      this.ctx.emit('chat/event', { type: 'message-delta', sessionId: id, messageId, delta })
    })

    ctx.on('agent/turn-end', (id) => {
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
    return this.ctx.sessions.list().map((meta) => {
      const session = this.ensure(meta.id)
      return {
        id: meta.id,
        title: meta.title,
        model: session.model,
        updatedAt: meta.updatedAt,
        messageCount: session.messages.length,
        streaming: session.streaming,
      }
    })
  }

  get(id: string): ChatSession | undefined {
    return this.ctx.sessions.has(id) ? this.ensure(id) : undefined
  }

  create(title?: string): ChatSession {
    const settings = this.ctx.get('settings', false) as
      | { raw(): { llm?: { activeProvider?: string; activeModel?: string } } }
      | undefined
    const llm = settings?.raw().llm
    const provider = llm?.activeProvider ?? this.ctx.llm.config.provider
    const model = llm?.activeModel
      ?? (provider === 'mock' || !provider ? this.ctx.llm.config.model : undefined)
    const meta = this.ctx.sessions.create({ title, model, provider })
    return this.ensure(meta.id)
  }

  send(id: string, text: string): ChatMessage {
    const user = this.ctx.agents.prompt(id, text)
    const session = this.ensure(id)
    return session.messages.find(message => message.id === user.id) ?? {
      id: user.id,
      role: 'user',
      blocks: [{ type: 'text', text: user.text }],
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
      createdAt: record.meta.createdAt,
      updatedAt: record.meta.updatedAt,
      messages: [],
      streaming: this.ctx.agents.isRunning(id),
    }
    for (const event of record.events) this.apply(session, event)
    this.sessions.set(id, session)
    return session
  }

  private onSessionEvent(id: string, event: SessionEvent) {
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
    } else if (event.type === 'turn/error') {
      const message = session.messages.find(item => item.id === `error-${event.seq}`)
      if (message) this.ctx.emit('chat/event', { type: 'message-added', sessionId: id, message })
    } else if (event.type === 'message/assistant') {
      const message = session.messages.find(item => item.id === event.data.id)
      if (message) this.ctx.emit('chat/event', { type: 'message-updated', sessionId: id, message })
    } else if (event.type === 'tool/result') {
      const message = session.messages.find(item => item.blocks.some(block =>
        block.type === 'tool' && block.callId === event.data.callId))
      if (message) this.ctx.emit('chat/event', { type: 'message-updated', sessionId: id, message })
    }

    this.touch(id, session)
  }

  private apply(session: ChatSession, event: SessionEvent) {
    if (event.type === 'message/user') {
      if (!session.messages.some(message => message.id === event.data.id)) {
        session.messages.push({
          id: event.data.id,
          role: 'user',
          blocks: [{ type: 'text', text: event.data.text }],
          status: 'done',
          createdAt: event.data.at ?? event.ts,
        })
      }
    } else if (event.type === 'message/assistant') {
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
    }
    session.updatedAt = Math.max(session.updatedAt, event.ts)
  }

  private syncMeta(session: ChatSession) {
    const meta = this.ctx.sessions.get(session.id)?.meta
    if (!meta) return
    session.title = meta.title
    session.model = meta.model ?? session.model
    session.updatedAt = meta.updatedAt
  }

  private touch(id: string, session: ChatSession) {
    const meta = this.ctx.sessions.get(id)?.meta
    if (meta) session.updatedAt = meta.updatedAt
    this.ctx.emit('chat/event', { type: 'session-updated', session })
  }
}

function blocksOf(parts: ContentPart[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'tool-call') {
      blocks.push({ type: 'tool', callId: part.id, name: part.name, input: part.arguments, output: '' })
    }
  }
  return blocks
}

export default ChatService
