import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { GiteeClient, GiteeError } from '../src/client.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function fixture(handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void) {
  const server = createServer((req, res) => handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return `http://127.0.0.1:${port}/api/v5`
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('gitee client', () => {
  it('sends the token in the header, never the query, and maps pages', async () => {
    let seen: { auth?: string; query?: string | null } = {}
    const base = await fixture((req, res, url) => {
      seen = { auth: req.headers.authorization, query: url.searchParams.get('access_token') }
      json(res, 200, [
        {
          full_name: 'yeswater/ruobai-harness',
          name: 'ruobai-harness',
          owner: { login: 'yeswater' },
          description: 'harness',
          private: false,
          html_url: 'https://gitee.com/yeswater/ruobai-harness',
          default_branch: 'main',
        },
        { full_name: 'yeswater/other', name: 'other', owner: { login: 'yeswater' }, private: true },
      ])
    })

    const client = new GiteeClient({ apiBase: base, token: 'secret-token', pageSize: 2, allowPrivateHost: true })
    const page = await client.listRepos()
    expect(seen).toEqual({ auth: 'token secret-token', query: null })
    expect(page.items[0]).toMatchObject({
      fullName: 'yeswater/ruobai-harness',
      owner: 'yeswater',
      private: false,
      defaultBranch: 'main',
    })
    expect(page.items[1]).toMatchObject({ fullName: 'yeswater/other', private: true })
    expect(page.hasMore).toBe(true)
    expect(page.page).toBe(1)
  })

  it('maps errors and redacts the token', async () => {
    const base = await fixture((_req, res) => {
      json(res, 401, { message: 'bad credential secret-token' })
    })
    const client = new GiteeClient({ apiBase: base, token: 'secret-token', allowPrivateHost: true })
    const error = await client.account().catch(caught => caught)
    expect(error).toBeInstanceOf(GiteeError)
    expect(error.status).toBe(401)
    expect(error.message).toContain('***')
    expect(error.message).not.toContain('secret-token')
  })

  it('requires a token before making a request', async () => {
    const client = new GiteeClient({ apiBase: 'http://127.0.0.1:9/api/v5', allowPrivateHost: true })
    await expect(client.listRepos()).rejects.toMatchObject({ status: 401 })
  })

  it('retries one GET 429 after Retry-After', async () => {
    let requests = 0
    const base = await fixture((_req, res) => {
      requests += 1
      if (requests === 1) {
        res.writeHead(429, { 'retry-after': '0.01', 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      json(res, 200, [])
    })
    const client = new GiteeClient({ apiBase: base, token: 'token', allowPrivateHost: true })
    await expect(client.listRepos()).resolves.toMatchObject({ items: [] })
    expect(requests).toBe(2)
  })

  it('rejects oversized responses', async () => {
    const base = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ filler: 'x'.repeat(500) }))
    })
    const client = new GiteeClient({ apiBase: base, token: 'token', maxBytes: 100, allowPrivateHost: true })
    const error = await client.account().catch(caught => caught)
    expect(error).toBeInstanceOf(GiteeError)
    expect(error.status).toBe(502)
    expect(error.message).toContain('大小上限')
  })

  it('refuses a redirect that leaves the API origin', async () => {
    const base = await fixture((_req, res) => {
      res.writeHead(302, { location: 'http://example.com/steal' })
      res.end()
    })
    const client = new GiteeClient({ apiBase: base, token: 'token', allowPrivateHost: true })
    await expect(client.account()).rejects.toMatchObject({ status: 502 })
  })

  it('decodes file contents and lists directories', async () => {
    const base = await fixture((_req, res, url) => {
      if (url.pathname.endsWith('/contents/README.md')) {
        json(res, 200, {
          path: 'README.md',
          size: 5,
          content: Buffer.from('hello').toString('base64'),
        })
        return
      }
      json(res, 200, [
        { name: 'src', path: 'src', type: 'dir' },
        { name: 'README.md', path: 'README.md', type: 'file', size: 5 },
      ])
    })
    const client = new GiteeClient({ apiBase: base, token: 'token', allowPrivateHost: true })
    const file = await client.contents('yeswater', 'repo', { path: 'README.md' })
    expect(file).toMatchObject({ path: 'README.md', content: 'hello', truncated: false, size: 5 })

    const dir = await client.contents('yeswater', 'repo', { path: '' })
    expect(dir.entries?.map(entry => `${entry.type}:${entry.name}`)).toEqual(['dir:src', 'file:README.md'])
  })
})
