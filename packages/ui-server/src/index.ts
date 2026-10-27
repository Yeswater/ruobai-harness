import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'
import type {} from '@ruobai/chat'
import { MAX_MESSAGE_BODY_BYTES, normalizeAttachments } from './attachments.ts'
import { summarizeActivity } from './activity.ts'
import { SseHub } from './sse.ts'

const STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const

/**
 * Plugins behind the control surface itself. Disabling one would take away the
 * settings page (or the API behind it) before it could be turned back on.
 */
const PROTECTED_PLUGINS = new Set([
  '@ruobai/cordis-plugin-include',
  '@ruobai/web-server',
  '@ruobai/web-static',
  '@ruobai/web-auth',
  '@ruobai/web-ws',
  '@ruobai/ui-server',
  '@ruobai/chat',
  '@ruobai/session',
  '@ruobai/modes',
  '@ruobai/approval',
  '@ruobai/context',
  '@ruobai/llm',
  '@ruobai/agent',
  '@ruobai/tools',
  '@ruobai/settings',
  '@ruobai/settings-web',
])

interface LoaderEntry {
  id: string
  options: { name: string; group?: boolean | null }
  disabled: boolean
  /** In-memory update: it must not call the tree's write(), which drops the
   * hand-written comments in cordis.yml. */
  update?(options: { disabled: boolean }): Promise<void>
  fiber?: {
    uid?: number
    state?: number
    store?: Record<string, unknown>
    runtime?: { callback?: { meta?: { title?: string; description?: string } } }
  }
}

interface LoaderLike {
  entries?(): Iterable<LoaderEntry>
}

declare module '@ruobai/cordis' {
  interface Context {
    ui: UiApi
  }
}

/**
 * Chat HTTP/SSE adapter: the only surface the browser knows.
 *
 * Mounted on the generic `web-server`; another plugin may serve static
 * assets, guard requests, or add WebSocket upgrades without touching this.
 */
export class UiApi extends Service {
  static inject = ['web', 'chat', 'sessions', 'modes', 'approval', 'context', 'llm']

  private readonly sse = new SseHub()

  constructor(ctx: Context) {
    super(ctx, 'ui')
    ctx.on('chat/event', event => this.sse.broadcast('chat', event))
    ctx.on('approval/requested', request => this.sse.broadcast('approval', { kind: 'requested', request }))
    ctx.on('approval/resolved', resolution => this.sse.broadcast('approval', { kind: 'resolved', resolution }))
  }

  /** Fan a plugin-owned event out to every live SSE client. */
  broadcast(channel: string, data: unknown) {
    this.sse.broadcast(channel, data)
  }

  async *[Service.init]() {
    yield this.ctx.web.register({
      prefix: '/api',
      handler: (req, res, url) => this.route(req, res, url),
    })
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      return await this.dispatch(req, res, url.pathname)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal error'
      const status = error instanceof HttpError
        ? error.status
        : message.startsWith('unknown session')
          ? 404
          : message.startsWith('unknown queued') ? 404
            : message.includes('running') ? 409
            : message.startsWith('unknown mode')
              || message.startsWith('title')
              || message.startsWith('unknown permission')
              || message.startsWith('permission')
              || message.startsWith('full access')
              || message.startsWith('unknown provider')
              || message.startsWith('provider')
              || message.startsWith('model')
              ? 400
              : 500
      if (status === 500) this.ctx.logger('ui').error(error)
      if (!res.headersSent) sendJson(res, status, { error: message })
      return true
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const method = req.method ?? 'GET'

    if (pathname === '/api/events') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      this.sse.attach(req, res)
      return true
    }

    if (pathname === '/api/sessions') {
      if (method === 'GET') {
        sendJson(res, 200, { sessions: this.ctx.chat.list() })
        return true
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined
        const mode = typeof body.mode === 'string' && body.mode ? body.mode : undefined
        const requested = typeof body.workspace === 'string' ? body.workspace.trim() : ''
        let workspace: string | undefined
        if (requested) {
          if (!isAbsolute(requested)) throw new HttpError(400, 'workspace must be an absolute path')
          const target = resolve(requested)
          const info = await stat(target).catch(() => undefined)
          if (!info?.isDirectory()) throw new HttpError(400, `workspace is not a directory: ${target}`)
          workspace = target
        }
        sendJson(res, 201, { session: this.ctx.chat.create(title, mode, workspace) })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    if (pathname === '/api/modes') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      sendJson(res, 200, { modes: this.ctx.modes.list(), default: this.ctx.modes.defaultId() })
      return true
    }

    if (pathname === '/api/activity') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      const sessions = this.ctx.sessions.list().map((meta) => {
        const record = this.ctx.sessions.get(meta.id)
        return { kind: meta.kind, events: record?.events ?? [] }
      })
      sendJson(res, 200, summarizeActivity(sessions))
      return true
    }

    if (pathname === '/api/models') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      const settings = this.ctx.get('settings', false) as
        | {
          get(): {
            llm?: {
              providers?: Array<{
                id: string
                name: string
                note?: string
                models: Array<{ id: string }>
              }>
            }
          }
        }
        | undefined
      const configured = new Map(
        (settings?.get().llm?.providers ?? []).map(entry => [entry.id, entry]),
      )
      // Prefer the provider's display name and its full configured model list
      // over the adapter's single default model.
      const providers = this.ctx.llm.list().map((provider) => {
        const entry = configured.get(provider.name)
        if (!entry) {
          return {
            id: provider.name,
            name: provider.name,
            models: provider.models.map(model => ({ id: model })),
          }
        }
        return {
          id: entry.id,
          name: entry.name,
          ...(entry.note ? { note: entry.note } : {}),
          models: entry.models.map(model => ({ ...model })),
        }
      })
      sendJson(res, 200, { providers })
      return true
    }

    if (pathname === '/api/protocols') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId')
        ?? undefined
      if (sessionId) {
        const sessions = this.ctx.get('sessions', false) as
          | { has(id: string): boolean }
          | undefined
        if (sessions && !sessions.has(sessionId)) throw new HttpError(404, 'unknown session')
      }
      const instructions = sessionId
        ? await this.ctx.context.instructionInfo(sessionId)
        : undefined
      const skills = this.ctx.get('skills', false) as
        | {
          list(id?: string): Promise<unknown[]>
          roots(id?: string): unknown[]
        }
        | undefined
      const mcpConfig = this.ctx.get('mcpConfig', false) as
        | { info(): Promise<unknown[]> }
        | undefined
      const a2a = this.ctx.get('a2a', false) as
        | { info(): unknown }
        | undefined
      sendJson(res, 200, {
        ...(instructions ? { instructions } : {}),
        ...(skills ? { skills: { items: await skills.list(sessionId), roots: skills.roots(sessionId) } } : {}),
        ...(mcpConfig ? { mcp: { files: await mcpConfig.info() } } : {}),
        ...(a2a ? { a2a: a2a.info() } : {}),
      })
      return true
    }

    if (pathname === '/api/approvals') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? undefined
      sendJson(res, 200, { approvals: this.ctx.approval.list(sessionId) })
      return true
    }

    const approval = /^\/api\/approvals\/([^/]+)$/.exec(pathname)
    if (approval) {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      const body = await readJson(req)
      const decision = body.decision
      if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') {
        throw new HttpError(400, 'decision must be allow, always or deny')
      }
      const resolved = this.ctx.approval.resolve(decodeURIComponent(approval[1]!), decision)
      if (!resolved) throw new HttpError(404, 'approval not found')
      sendJson(res, 200, { ok: true })
      return true
    }

    if (pathname === '/api/runtime') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      sendJson(res, 200, this.runtime())
      return true
    }

    const plugin = /^\/api\/plugins\/([^/]+)$/.exec(pathname)
    if (plugin) {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      const loader = this.ctx.get('loader', false) as LoaderLike | undefined
      if (!loader?.entries) throw new HttpError(503, 'plugin loader is not available')
      const entryId = decodeURIComponent(plugin[1]!)
      const body = await readJson(req)
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean')
      const entry = [...loader.entries()].find(item => item.id === entryId)
      if (!entry) throw new HttpError(404, 'plugin entry not found')
      if (PROTECTED_PLUGINS.has(entry.options.name)) {
        throw new HttpError(400, 'this plugin keeps the control surface running')
      }
      if (!entry.update) throw new HttpError(400, 'this plugin entry cannot be toggled')
      try {
        // Update the entry directly rather than loader.update(): the latter
        // writes the entry tree back and strips cordis.yml's comments.
        await entry.update({ disabled: !body.enabled })
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error))
      }
      sendJson(res, 200, this.runtime())
      return true
    }

    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|stop|mode|model|permission|context|fork|trajectory|compact|queued)(?:\/([^/]+))?(?:\/(send))?)?$/.exec(pathname)
    if (!match) return false
    const id = decodeURIComponent(match[1]!)
    const action = match[2]
    const queuedId = match[3] ? decodeURIComponent(match[3]) : undefined
    const queuedAction = match[4]

    if (!action && method === 'GET') {
      const session = this.ctx.chat.get(id)
      if (!session) throw new HttpError(404, 'session not found')
      sendJson(res, 200, { session })
      return true
    }

    if (!action && method === 'PATCH') {
      const body = await readJson(req)
      const hasTitle = body.title !== undefined
      const hasArchived = body.archived !== undefined
      if (!hasTitle && !hasArchived) throw new HttpError(400, 'title or archived is required')
      if (hasTitle && (typeof body.title !== 'string' || !body.title.trim())) {
        throw new HttpError(400, 'title must not be empty')
      }
      if (hasArchived && typeof body.archived !== 'boolean') {
        throw new HttpError(400, 'archived must be a boolean')
      }
      let session = hasTitle ? this.ctx.chat.rename(id, body.title) : this.ctx.chat.get(id)
      if (!session) throw new HttpError(404, 'session not found')
      if (hasArchived) session = this.ctx.chat.setArchived(id, body.archived)
      sendJson(res, 200, { session })
      return true
    }

    if (!action && method === 'DELETE') {
      this.ctx.chat.remove(id)
      sendJson(res, 200, { ok: true })
      return true
    }

    if (action === 'fork' && method === 'POST') {
      const body = await readJson(req)
      const upToSeq = typeof body.upToSeq === 'number' && Number.isFinite(body.upToSeq)
        ? body.upToSeq
        : undefined
      sendJson(res, 201, { session: this.ctx.chat.fork(id, upToSeq) })
      return true
    }

    if (action === 'context' && method === 'GET') {
      sendJson(res, 200, await this.ctx.context.info(id))
      return true
    }

    if (action === 'trajectory' && method === 'GET') {
      const record = this.ctx.sessions.get(id)
      if (!record) throw new HttpError(404, 'session not found')
      sendJson(res, 200, {
        events: record.events
          .map(trajectoryEvent)
          .filter(Boolean),
      })
      return true
    }

    if (action === 'compact' && method === 'POST') {
      const session = this.ctx.chat.get(id)
      if (!session) throw new HttpError(404, 'session not found')
      if (session.streaming) throw new HttpError(409, 'session is running')
      const record = this.ctx.sessions.get(id)
      if (!record) throw new HttpError(404, 'session not found')
      const settings = this.ctx.get('settings', false) as
        | {
          raw?(): {
            llm?: { activeProvider?: string; activeModel?: string }
          }
        }
        | undefined
      const agents = this.ctx.get('agents', false) as
        | { config?: { systemPrompt?: string } }
        | undefined
      const modes = this.ctx.get('modes', false) as
        | { get(mode?: string): { systemPrompt?: string } | undefined }
        | undefined
      const config = settings?.raw?.()
      const provider = record.meta.provider ?? config?.llm?.activeProvider
      const model = record.meta.model ?? config?.llm?.activeModel
      const modePrompt = modes?.get(record.meta.mode)?.systemPrompt
      const info = await this.ctx.context.compactNow(id, {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(agents?.config?.systemPrompt ? { basePrompt: agents.config.systemPrompt } : {}),
        ...(modePrompt ? { modePrompt } : {}),
      })
      sendJson(res, 200, { compacted: Boolean(info), info })
      return true
    }

    if (action === 'mode' && method === 'POST') {
      const body = await readJson(req)
      const mode = typeof body.mode === 'string' ? body.mode.trim() : ''
      if (!mode) throw new HttpError(400, 'mode is required')
      sendJson(res, 200, { session: this.ctx.chat.setMode(id, mode) })
      return true
    }

    if (action === 'model' && method === 'POST') {
      const body = await readJson(req)
      const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!provider || !model) throw new HttpError(400, 'provider and model are required')
      sendJson(res, 200, { session: this.ctx.chat.setModel(id, provider, model) })
      return true
    }

    if (action === 'permission' && method === 'POST') {
      const body = await readJson(req)
      const mode = typeof body.mode === 'string' ? body.mode.trim() : ''
      if (!mode) throw new HttpError(400, 'permission mode is required')
      sendJson(res, 200, { session: this.ctx.chat.setPermission(id, mode, body.confirm === true) })
      return true
    }

    if (action === 'messages' && method === 'POST') {
      const body = await readJson(req, MAX_MESSAGE_BODY_BYTES)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      const attachments = normalizeAttachments(body.attachments)
      if (!text && !attachments.length) throw new HttpError(400, 'text or attachments are required')
      if (attachments.some(attachment => attachment.kind === 'image')) {
        const session = this.ctx.chat.get(id)
        const settings = this.ctx.get('settings', false) as
          | {
            findProvider?(id: string): {
              models: Array<{ id: string; inputTypes?: string[] }>
            } | undefined
          }
          | undefined
        const model = session?.provider
          ? settings?.findProvider?.(session.provider)?.models.find(item => item.id === session.model)
          : undefined
        if (model?.inputTypes && !model.inputTypes.includes('image')) {
          throw new HttpError(400, `模型 ${session?.model ?? ''} 不支持图片输入`)
        }
      }
      const result = this.ctx.chat.send(id, text, attachments)
      sendJson(res, 201, { message: result.message, queued: result.queued })
      return true
    }

    if (action === 'queued' && method === 'DELETE') {
      if (!queuedId) throw new HttpError(400, 'queued message id is required')
      const queued = this.ctx.chat.withdraw(id, queuedId)
      sendJson(res, 200, { queued, session: this.ctx.chat.get(id) })
      return true
    }

    if (action === 'queued' && method === 'POST' && queuedAction === 'send') {
      if (!queuedId) throw new HttpError(400, 'queued message id is required')
      sendJson(res, 200, { session: this.ctx.chat.sendNow(id, queuedId) })
      return true
    }

    if (action === 'stop' && method === 'POST') {
      this.ctx.chat.stop(id)
      sendJson(res, 200, { ok: true })
      return true
    }

    throw new HttpError(405, 'method not allowed')
  }

  private runtime() {
    const plugins: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        const meta = (fiber.runtime?.callback as {
          meta?: { title?: string; description?: string }
        } | undefined)?.meta
        const entry = (fiber as unknown as { entry?: LoaderEntry }).entry
        const entryId = entry?.id
        if (entryId) seen.add(entryId)
        const toggleable = Boolean(entryId) && !PROTECTED_PLUGINS.has(entry?.options.name ?? '')
        const stableId = entryId && !/^[0-9a-f]{8,}$/i.test(entryId)
          ? entryId
          : pluginSlug(fiber.name)
        plugins.push({
          uid: fiber.uid,
          id: `ruobai-${stableId}`,
          name: fiber.name,
          ...(meta?.title ? { title: meta.title } : {}),
          ...(meta?.description ? { description: meta.description } : {}),
          state: STATES[fiber.state] ?? 'UNKNOWN',
          services: Object.keys(fiber.store ?? {}),
          enabled: true,
          ...(entryId ? { entryId } : {}),
          ...(toggleable ? { toggleable: true } : {}),
        })
      }
    }

    // A disabled entry has no fiber, so it only exists in the loader tree.
    const loader = this.ctx.get('loader', false) as LoaderLike | undefined
    if (loader?.entries) {
      for (const entry of loader.entries()) {
        if (entry.fiber || seen.has(entry.id) || entry.options.group) continue
        if (PROTECTED_PLUGINS.has(entry.options.name)) continue
        plugins.push({
          uid: null,
          id: `ruobai-${pluginSlug(entry.options.name.split('/').pop() ?? entry.options.name)}`,
          name: entry.options.name,
          title: entry.options.name.replace(/^@[^/]+\//, ''),
          state: entry.disabled ? 'DISABLED' : 'PENDING',
          services: [],
          entryId: entry.id,
          enabled: !entry.disabled,
          toggleable: true,
        })
      }
    }

    const services = Object.entries(this.ctx.reflect.props)
      .filter(([, property]) => property.type === 'service')
      .map(([name]) => name)
    return { plugins, services, url: this.ctx.web.url }
  }
}

export default UiApi

export const meta = {
  title: 'Web API',
  description: '提供会话、审批、上下文与事件流接口。',
}

function pluginSlug(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '') || 'plugin'
}

const TRAJECTORY_CLIP = 12_000

function clip(value: unknown, limit = TRAJECTORY_CLIP) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`
}

/** Browser-safe projection of one session event for the trajectory view. */
function trajectoryEvent(event: { seq: number; ts: number; type: string; data: any }) {
  const base = { seq: event.seq, ts: event.ts, type: event.type }
  const data = event.data ?? {}
  switch (event.type) {
    case 'message/user':
      return {
        ...base,
        data: {
          id: data.id,
          text: clip(data.text),
          at: data.at,
          attachments: (data.attachments ?? []).map((attachment: any) => ({
            id: attachment.id,
            name: attachment.name,
            kind: attachment.kind,
            mime: attachment.mime,
            size: attachment.size,
            ...(attachment.path ? { path: attachment.path } : {}),
          })),
          ...(data.source ? { source: data.source } : {}),
        },
      }
    case 'message/assistant':
      return {
        ...base,
        data: {
          id: data.id,
          at: data.at,
          parts: (data.parts ?? []).map((part: any) => {
            if (part.type === 'text') return { type: 'text', text: clip(part.text) }
            if (part.type === 'reasoning') return { type: 'reasoning', text: clip(part.text) }
            if (part.type === 'tool-call') {
              return {
                type: 'tool-call',
                id: part.id,
                name: part.name,
                arguments: clip(part.arguments, 4_000),
              }
            }
            if (part.type === 'tool-result') {
              return {
                type: 'tool-result',
                callId: part.callId,
                name: part.name,
                content: clip(part.content, 4_000),
                isError: part.isError,
              }
            }
            return { type: part.type }
          }),
        },
      }
    case 'tool/result':
      return {
        ...base,
        data: {
          callId: data.callId,
          name: data.name,
          isError: Boolean(data.isError),
          content: clip(data.content),
          chars: String(data.content ?? '').length,
        },
      }
    case 'context/summary':
      return {
        ...base,
        data: {
          upToSeq: data.upToSeq,
          text: clip(data.text, 20_000),
          at: data.at,
          before: data.before,
          after: data.after,
          trigger: data.trigger,
        },
      }
    case 'context/memory':
      return { ...base, data: { upToSeq: data.upToSeq, text: clip(data.text, 4_000), at: data.at } }
    case 'context/snapshot':
      return {
        ...base,
        data: {
          at: data.at,
          step: data.step,
          workspace: data.workspace,
          provider: data.provider,
          model: data.model,
          mode: data.mode,
          permission: data.permission,
          messages: data.messages,
          tools: data.tools,
          turns: data.turns,
          systemChars: data.systemChars,
          estimatedTokens: data.estimatedTokens,
          ...(data.summaryUpToSeq !== undefined ? { summaryUpToSeq: data.summaryUpToSeq } : {}),
          ...(data.memoryUpToSeq !== undefined ? { memoryUpToSeq: data.memoryUpToSeq } : {}),
          focus: clip(data.focus, 400),
        },
      }
    case 'turn/error':
      return { ...base, data: { message: clip(data.message, 4_000) } }
    case 'turn/notice':
    case 'session/title':
    case 'session/meta':
      return { ...base, data }
    default:
      return { ...base, data: JSON.stringify(data).length <= 8_000 ? data : undefined }
  }
}
