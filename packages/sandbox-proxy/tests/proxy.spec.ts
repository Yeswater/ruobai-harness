import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SandboxProxy from '../src/index.ts'
import { hostAllowed, parseRule, splitAuthority } from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function upstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.end('ok'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return { server, port: (server.address() as AddressInfo).port }
}

async function proxyWith(allowedDomains: string[]): Promise<{ ctx: Context; port: number }> {
  const ctx = new Context()
  const proxy = ctx.plugin(SandboxProxy, { allowedDomains, allowLocalBinding: true })
  await proxy
  cleanups.push(() => proxy.dispose())
  return { ctx, port: ctx.sandboxProxy.port }
}

function viaProxy(port: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: url, method: 'GET' }, (response) => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

function connectThrough(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let buffer = ''
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    socket.on('data', function onData(chunk) {
      buffer += chunk.toString('latin1')
      if (!buffer.includes('\r\n\r\n')) return
      socket.off('data', onData)
      socket.destroy()
      resolve(buffer)
    })
    socket.on('error', reject)
  })
}

describe('allowlist matching', () => {
  it('matches exact hosts, wildcard subdomains and optional ports', () => {
    expect(hostAllowed('example.com', 443, ['example.com'])).toBe(true)
    expect(hostAllowed('api.example.com', 443, ['*.example.com'])).toBe(true)
    expect(hostAllowed('example.com', 443, ['*.example.com'])).toBe(false)
    expect(hostAllowed('example.com', 80, ['example.com:80'])).toBe(true)
    expect(hostAllowed('example.com', 443, ['example.com:80'])).toBe(false)
    expect(hostAllowed('anything.test', 443, ['*'])).toBe(true)
  })

  it('parses IPv6 authorities and bracketed rules', () => {
    expect(splitAuthority('[::1]:8443')).toEqual({ host: '::1', port: 8443 })
    expect(splitAuthority('example.com:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseRule('[::1]:8443')).toEqual({ host: '::1', port: 8443 })
  })
})

describe('sandbox egress proxy', () => {
  it('forwards an allowed http host and blocks the rest', async () => {
    const target = await upstream()
    const { ctx, port } = await proxyWith([`127.0.0.1:${target.port}`])
    const started = Date.now()

    const allowed = await viaProxy(port, `http://127.0.0.1:${target.port}/`)
    expect(allowed).toEqual({ status: 200, body: 'ok' })

    const blocked = await viaProxy(port, 'http://127.0.0.1:9/')
    expect(blocked.status).toBe(403)
    expect(blocked.body).toContain('不在允许的域名列表')
    expect(ctx.sandboxProxy.deniedSince(started)).toContain('127.0.0.1')
  })

  it('filters CONNECT by host before opening a tunnel', async () => {
    const target = await upstream()
    const { port } = await proxyWith([`127.0.0.1:${target.port}`])

    const denied = await connectThrough(port, 'blocked.test:443')
    expect(denied.startsWith('HTTP/1.1 403')).toBe(true)

    const allowed = await connectThrough(port, `127.0.0.1:${target.port}`)
    expect(allowed.startsWith('HTTP/1.1 200')).toBe(true)
  })

  it('exports proxy environment for sandboxed children', async () => {
    const { ctx, port } = await proxyWith(['example.com'])
    const env = ctx.sandboxProxy.env()
    expect(env.HTTP_PROXY).toBe(`http://127.0.0.1:${port}`)
    expect(env.NO_PROXY).toContain('localhost')
    expect(await ctx.sandboxProxy.summary()).toMatchObject({
      active: true,
      domains: 1,
      allowLocalBinding: true,
    })
  })
})
