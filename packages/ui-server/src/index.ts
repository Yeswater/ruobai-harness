import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service, type Context } from '@ruobai/cordis'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'
import type {} from '@ruobai/chat'
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
  static inject = ['web', 'chat']

  private readonly sse = new SseHub()

  constructor(ctx: Context) {
    super(ctx, 'ui')
    ctx.on('chat/event', event => this.sse.broadcast('chat', event))
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
          : message.includes('already running') ? 409 : 500
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
        sendJson(res, 201, { session: this.ctx.chat.create(title) })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    if (pathname === '/api/runtime') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      sendJson(res, 200, this.runtime())
      return true
    }

    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|stop))?$/.exec(pathname)
    if (!match) return false
    const id = decodeURIComponent(match[1]!)
    const action = match[2]

    if (!action && method === 'GET') {
      const session = this.ctx.chat.get(id)
      if (!session) throw new HttpError(404, 'session not found')
      sendJson(res, 200, { session })
      return true
    }

    if (action === 'messages' && method === 'POST') {
      const body = await readJson(req)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) throw new HttpError(400, 'text is required')
      sendJson(res, 201, { message: this.ctx.chat.send(id, text) })
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
        plugins.push({
          uid: fiber.uid,
          name: fiber.name,
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
