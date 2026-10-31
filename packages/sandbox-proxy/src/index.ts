import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Service, type Context } from '@ruobai/cordis'
import { DEFAULT_ALLOWED_DOMAINS } from '@ruobai/sandbox'
import type {} from '@ruobai/settings'

export interface Config {
  /** Overrides the settings list; used by tests and headless embeddings. */
  allowedDomains?: string[]
  allowLocalBinding?: boolean
}

export interface ProxyRule {
  host: string
  port?: number
}

/**
 * Parse one allowlist entry: `example.com`, `*.example.com` or
 * `example.com:8080`. IPv6 literals stay in brackets.
 */
export function parseRule(entry: string): ProxyRule | undefined {
  const value = entry.trim().toLowerCase()
  if (!value) return undefined
  if (value === '*') return { host: '*' }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed) {
    return { host: bracketed[1]!, ...(bracketed[2] ? { port: Number(bracketed[2]) } : {}) }
  }
  const match = /^(.+?)(?::(\d+))?$/.exec(value)
  if (!match) return undefined
  return { host: match[1]!, ...(match[2] ? { port: Number(match[2]) } : {}) }
}

/** Whether `host:port` is covered by an allowlist. Wildcards match subdomains. */
export function hostAllowed(host: string, port: number | undefined, entries: readonly string[]): boolean {
  const target = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of entries) {
    const rule = parseRule(raw)
    if (!rule) continue
    if (rule.port !== undefined && port !== undefined && rule.port !== port) continue
    if (rule.host === '*') return true
    if (rule.host.startsWith('*.')) {
      const suffix = rule.host.slice(1)
      if (target.endsWith(suffix) && target.length > suffix.length) return true
      continue
    }
    if (target === rule.host) return true
  }
  return false
}

/** `host:port` from a CONNECT request line, IPv6-safe. */
export function splitAuthority(authority: string): { host: string; port: number } {
  const value = authority.trim()
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(value)
  if (bracketed) return { host: bracketed[1]!, port: Number(bracketed[2]) }
  const index = value.lastIndexOf(':')
  if (index > 0) {
    const port = Number(value.slice(index + 1))
    if (Number.isFinite(port)) return { host: value.slice(0, index), port }
  }
  return { host: value, port: 443 }
}

function hopByHop(headers: IncomingMessage['headers']): Record<string, string | string[] | undefined> {
  const copy: Record<string, string | string[] | undefined> = { ...headers }
  for (const name of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'upgrade']) {
    delete copy[name]
  }
  return copy
}

function proxyAuth(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined
  return `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
}

declare module '@ruobai/cordis' {
  interface Context {
    sandboxProxy: SandboxProxyService
  }
}

/**
 * Domain-filtering egress proxy for sandboxed commands.
 *
 * The sandbox profile only lets a command reach this loopback port; the proxy
 * decides which hosts are reachable and forwards through the user's system
 * proxy when one is configured. HTTPS is tunnelled, so filtering is by host,
 * not by path or certificate.
 */
export class SandboxProxyService extends Service {
  static inject: string[] = []

  private server?: ReturnType<typeof createServer>
  private actualPort = 0
  private upstreamCache?: { at: number; url?: URL }
  private readonly denied: Array<{ host: string; at: number }> = []

  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'sandboxProxy')
  }

  async *[Service.init]() {
    const server = createServer((req, res) => {
      void this.plain(req, res).catch((error) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`sandbox proxy error: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    server.on('connect', (req, socket, head) => {
      void this.tunnel(req, socket, head).catch((error) => {
        try {
          socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error instanceof Error ? error.message : String(error)}`)
        } catch {
          socket.destroy()
        }
      })
    })
    server.on('clientError', (_error, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        socket.destroy()
      }
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.actualPort = (server.address() as AddressInfo).port
        resolve()
      })
    })
    this.server = server

    yield () => {
      this.actualPort = 0
      this.server = undefined
      server.close()
      server.closeAllConnections?.()
    }
  }

  get port(): number {
    return this.actualPort
  }

  get active(): boolean {
    return this.actualPort > 0
  }

  domains(): string[] {
    if (this.config.allowedDomains) return [...this.config.allowedDomains]
    const configured = this.ctx.get('settings', false) === undefined
      ? undefined
      : (this.ctx.get('settings', false) as { get(): { sandbox?: { network?: { allowedDomains?: string[] } } } })
          .get().sandbox?.network?.allowedDomains
    return configured ?? [...DEFAULT_ALLOWED_DOMAINS]
  }

  allowLocalBinding(): boolean {
    if (this.config.allowLocalBinding !== undefined) return this.config.allowLocalBinding
    const settings = this.ctx.get('settings', false) as
      | { get(): { sandbox?: { network?: { allowLocalBinding?: boolean } } } }
      | undefined
    return settings?.get().sandbox?.network?.allowLocalBinding !== false
  }

  allows(host: string, port?: number): boolean {
    return hostAllowed(host, port, this.domains())
  }

  /** Domains the proxy rejected at or after `since` (ms). */
  deniedSince(since: number): string[] {
    return [...new Set(this.denied.filter(entry => entry.at >= since).map(entry => entry.host))]
  }

  /** Environment for a sandboxed child: every HTTP path goes through us. */
  env(): Record<string, string> {
    const url = `http://127.0.0.1:${this.actualPort}`
    return {
      HTTP_PROXY: url,
      http_proxy: url,
      HTTPS_PROXY: url,
      https_proxy: url,
      ALL_PROXY: url,
      all_proxy: url,
      NO_PROXY: 'localhost,127.0.0.1,::1,[::1]',
      no_proxy: 'localhost,127.0.0.1,::1,[::1]',
    }
  }

  async summary() {
    const upstream = await this.upstream()
    return {
      active: this.active,
      port: this.actualPort,
      domains: this.domains().length,
      allowLocalBinding: this.allowLocalBinding(),
      ...(upstream ? { upstream: `${upstream.host}${upstream.port ? `:${upstream.port}` : ''}` } : {}),
    }
  }

  private async plain(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = this.targetOf(req.url)
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('sandbox proxy: expected an absolute http:// URL')
      return
    }
    if (!this.allows(target.hostname, target.port ? Number(target.port) : 80)) {
      this.deny(res, target.hostname)
      return
    }

    const upstream = await this.upstream()
    const headers = hopByHop(req.headers)
    headers.host = target.host
    if (upstream) {
      const auth = proxyAuth(upstream)
      if (auth) headers['proxy-authorization'] = auth
    }
    const request = httpRequest({
      ...(upstream
        ? { host: upstream.hostname, port: upstream.port ? Number(upstream.port) : 80, path: target.href }
        : {
            host: target.hostname,
            port: target.port ? Number(target.port) : 80,
            path: `${target.pathname}${target.search}`,
          }),
      method: req.method,
      headers,
    }, (proxied) => {
      res.writeHead(proxied.statusCode ?? 502, proxied.statusMessage ?? '', proxied.headers)
      proxied.pipe(res)
    })
    request.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`sandbox proxy: ${error.message}`)
    })
    req.pipe(request)
  }

  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    // A client that hangs up mid-CONNECT must not surface as an uncaught error.
    client.on('error', () => client.destroy())
    const { host, port } = splitAuthority(req.url ?? '')
    if (!this.allows(host, port)) {
      this.recordDeny(host)
      client.end(
        'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(this.denyMessage(host))}\r\n\r\n`
        + this.denyMessage(host),
      )
      return
    }

    const upstream = await this.upstream()
    const upstreamAuth = upstream ? proxyAuth(upstream) : undefined
    const socket = upstream
      ? await this.connectVia(upstream, host, port, upstreamAuth)
      : await new Promise<Socket>((resolve, reject) => {
          const direct = netConnect({ host, port })
          direct.once('connect', () => resolve(direct))
          direct.once('error', reject)
        })

    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) socket.write(head)
    socket.pipe(client)
    client.pipe(socket)
    const close = () => {
      socket.destroy()
      client.destroy()
    }
    socket.on('error', close)
    client.on('error', close)
    socket.on('close', () => client.destroy())
    client.on('close', () => socket.destroy())
  }

  private connectVia(upstream: URL, host: string, port: number, auth: string | undefined): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({
        host: upstream.hostname,
        port: upstream.port ? Number(upstream.port) : 80,
      })
      let buffer = ''
      const onError = (error: Error) => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.write(
          `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`
          + `${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`,
        )
      })
      socket.on('data', function onData(chunk) {
        buffer += chunk.toString('latin1')
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        socket.off('data', onData)
        const status = Number(/^HTTP\/\d\.\d\s+(\d+)/.exec(buffer)?.[1])
        if (status !== 200) {
          socket.destroy()
          reject(new Error(`upstream proxy refused CONNECT: ${buffer.split('\r\n')[0]}`))
          return
        }
        socket.removeListener('error', onError)
        resolve(socket)
      })
    })
  }

  private targetOf(raw: string | undefined): URL | undefined {
    if (!raw) return undefined
    try {
      const url = new URL(raw)
      return url.protocol === 'http:' ? url : undefined
    } catch {
      return undefined
    }
  }

  private async upstream(): Promise<URL | undefined> {
    const cached = this.upstreamCache
    if (cached && Date.now() - cached.at < 15_000) return cached.url
    const net = this.ctx.get('net', false) as
      | { status?(force?: boolean): Promise<{ effective?: { https?: string; http?: string } }> }
      | undefined
    let url: URL | undefined
    try {
      const status = await net?.status?.(false)
      const raw = status?.effective?.https ?? status?.effective?.http
      if (raw) url = new URL(raw)
    } catch {
      url = undefined
    }
    this.upstreamCache = { at: Date.now(), url }
    return url
  }

  private denyMessage(host: string): string {
    return `sandbox proxy: ${host} 不在允许的域名列表中。请在 设置 → 沙箱 → 允许的域名 中添加，或经批准后不经沙箱重试。\n`
  }

  private deny(res: ServerResponse, host: string): void {
    this.recordDeny(host)
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(this.denyMessage(host))
  }

  private recordDeny(host: string): void {
    this.denied.push({ host, at: Date.now() })
    if (this.denied.length > 100) this.denied.splice(0, this.denied.length - 100)
  }
}

export default SandboxProxyService

export const meta = {
  title: '沙箱网络代理',
  description: '沙箱内命令唯一可用的出口；按域名白名单放行，并转发到系统代理。',
}
