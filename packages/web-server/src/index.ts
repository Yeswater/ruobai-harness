import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

export type WebHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => boolean | void | Promise<boolean | void>

export interface WebRoute {
  /** Match the pathname itself and everything below it. */
  prefix?: string
  /** Match one exact pathname. */
  exact?: string
  handler: WebHandler
}

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

export interface Config {
  host?: string
  port?: number
}

declare module '@ruobai/cordis' {
  interface Context {
    web: WebServer
  }

  interface Events {
    'web/ready'(url: string): void
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

export function sendText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

export function notFound(res: ServerResponse) {
  if (!res.headersSent) sendText(res, 404, 'not found')
  else res.end()
}

/**
 * Generic HTTP host: guards, route table, one fallback, and upgrade handlers.
 *
 * It knows nothing about chat or static assets; those are plugins that
 * register into it, which keeps auth/ws/static composable.
 */
export class WebServer extends Service {
  static Config: z<Config> = z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().min(0).default(4310),
  })

  public url = ''

  private server?: Server
  private routes: WebRoute[] = []
  private guards: WebHandler[] = []
  private readonly upgrades = new Map<string, UpgradeHandler>()
  private fallback?: WebHandler

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'web')
  }

  get httpServer() {
    return this.server
  }

  /** Register a route; runs before the fallback. Returns its disposer. */
  register(route: WebRoute): () => void {
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }

  /** Run a guard before every route; return `true` to stop dispatch. */
  use(guard: WebHandler): () => void {
    this.guards.push(guard)
    return () => {
      const index = this.guards.indexOf(guard)
      if (index >= 0) this.guards.splice(index, 1)
    }
  }

  /** Claim the static/SPA slot. Only one owner; returns its disposer. */
  setFallback(handler: WebHandler): () => void {
    this.fallback = handler
    return () => {
      if (this.fallback === handler) this.fallback = undefined
    }
  }

  /** Attach a WebSocket upgrade handler for one exact pathname. */
  registerUpgrade(pathname: string, handler: UpgradeHandler): () => void {
    this.upgrades.set(pathname, handler)
    return () => {
      if (this.upgrades.get(pathname) === handler) this.upgrades.delete(pathname)
    }
  }

  async *[Service.init]() {
    const server = this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error)
      server.once('error', onError)
      server.listen(this.config.port ?? 4310, this.config.host ?? '127.0.0.1', () => {
        server.off('error', onError)
        resolveListen()
      })
    })

    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : (this.config.port ?? 4310)
    this.url = `http://${this.config.host ?? '127.0.0.1'}:${port}`
    this.ctx.emit('web/ready', this.url)

    yield async () => {
      server.off('upgrade', this.handleUpgrade)
      await new Promise<void>((done) => {
        if (!server.listening) return done()
        server.close(() => done())
        server.closeAllConnections?.()
      })
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let url: URL
    try {
      url = new URL(req.url ?? '/', this.url || 'http://localhost')
    } catch {
      sendText(res, 400, 'bad request')
      return
    }

    try {
      for (const guard of this.guards) {
        if (await guard(req, res, url) === true) return
      }
      for (const route of this.routes) {
        if (!matches(route, url.pathname)) continue
        if (await route.handler(req, res, url) === true) return
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      if (this.fallback) {
        if (await this.fallback(req, res, url) === true) return
        return
      }
      notFound(res)
    } catch (error) {
      this.ctx.logger('web').error(error)
      if (!res.headersSent) {
        const status = error instanceof HttpError ? error.status : 500
        sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
      } else {
        res.end()
      }
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    const handler = this.upgrades.get(pathname)
    // Other plugins (e.g. Vite's HMR server) may own their own upgrade
    // listeners; only claim paths registered here.
    if (!handler) return
    try {
      handler(req, socket, head)
    } catch (error) {
      this.ctx.logger('web').error(error)
      socket.destroy()
    }
  }
}

function matches(route: WebRoute, pathname: string) {
  if (route.exact !== undefined) return pathname === route.exact
  if (route.prefix !== undefined) {
    return pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)
  }
  return true
}

export default WebServer
