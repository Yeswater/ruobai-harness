import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'
import type {} from '@ruobai/chat'
import { MAX_MESSAGE_BODY_BYTES, normalizeAttachments } from './attachments.ts'
import { SseHub } from './sse.ts'

const STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const

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
  static inject = ['web', 'chat', 'modes', 'approval', 'context', 'llm']

  private readonly sse = new SseHub()

  constructor(ctx: Context) {
    super(ctx, 'ui')
    ctx.on('chat/event', event => this.sse.broadcast('chat', event))
    ctx.on('approval/requested', request => this.sse.broadcast('approval', { kind: 'requested', request }))
    ctx.on('approval/resolved', resolution => this.sse.broadcast('approval', { kind: 'resolved', resolution }))
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

    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|stop|mode|model|permission|context|fork))?$/.exec(pathname)
    if (!match) return false
    const id = decodeURIComponent(match[1]!)
    const action = match[2]

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
      sendJson(res, 201, { message: this.ctx.chat.send(id, text, attachments) })
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
    const plugins: unknown[] = []
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        const meta = (fiber.runtime?.callback as {
          meta?: { title?: string; description?: string }
        } | undefined)?.meta
        const entryId = (fiber as unknown as {
          entry?: { options?: { id?: string } }
        }).entry?.options?.id
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
