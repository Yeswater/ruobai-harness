import { createServer, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []
const servers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
  while (servers.length) await servers.pop()!()
})

async function fixture() {
  const auths: Array<string | undefined> = []
  const writes: Array<{ kind: string; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    auths.push(req.headers.authorization)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/api/v5/user') {
      return json(res, 200, { login: 'yeswater', name: 'Yes Water', avatar_url: 'https://example.com/a.png' })
    }
    if (path === '/api/v5/user/repos') {
      return json(res, 200, [{
        full_name: 'yeswater/ruobai-harness',
        name: 'ruobai-harness',
        owner: { login: 'yeswater' },
        description: 'harness',
        private: false,
        html_url: 'https://gitee.com/yeswater/ruobai-harness',
        default_branch: 'main',
      }])
    }
    if (path === '/api/v5/repos/yeswater/ruobai-harness') {
      return json(res, 200, {
        full_name: 'yeswater/ruobai-harness',
        name: 'ruobai-harness',
        owner: { login: 'yeswater' },
        description: 'harness',
        private: false,
        default_branch: 'main',
      })
    }
    if (path.endsWith('/branches')) {
      return json(res, 200, [{ name: 'main', commit: { sha: 'abcdef123456' } }])
    }
    if (path.endsWith('/commits')) {
      return json(res, 200, [{
        sha: 'abcdef123456',
        commit: { message: 'feat: init', author: { name: 'Yes Water', date: '2026-10-01T00:00:00Z' } },
      }])
    }
    if (path.endsWith('/releases')) {
      return json(res, 200, [{ id: 1, tag_name: 'v0.1.0', name: 'v0.1.0', created_at: '2026-10-01T00:00:00Z' }])
    }
    if (req.method === 'POST' && path.endsWith('/comments')) {
      void readBody(req).then((body) => {
        writes.push({ kind: path.includes('/pulls/') ? 'pull-comment' : 'issue-comment', body })
        json(res, 201, {})
      })
      return
    }
    if (req.method === 'POST' && path.endsWith('/issues')) {
      void readBody(req).then((body) => {
        writes.push({ kind: 'issue-create', body })
        json(res, 201, {
          number: 8,
          title: body.title,
          state: 'open',
          user: { login: 'yeswater' },
          body: body.body,
        })
      })
      return
    }
    if (req.method === 'PATCH' && /\/issues\/\d+$/.test(path)) {
      void readBody(req).then((body) => {
        writes.push({ kind: 'issue-close', body })
        json(res, 200, {
          number: Number(path.split('/').at(-1)),
          title: '离线测试 Issue',
          state: body.state ?? 'closed',
          user: { login: 'yeswater' },
        })
      })
      return
    }
    if (req.method === 'POST' && path.endsWith('/pulls')) {
      void readBody(req).then((body) => {
        writes.push({ kind: 'pull-create', body })
        json(res, 201, {
          number: 4,
          title: body.title,
          state: 'open',
          user: { login: 'yeswater' },
          head: { ref: body.head },
          base: { ref: body.base },
        })
      })
      return
    }
    if (path.endsWith('/issues')) {
      return json(res, 200, [{
        number: 7,
        title: '离线测试 Issue',
        state: 'open',
        user: { login: 'yeswater' },
        labels: [{ name: 'bug' }],
      }])
    }
    if (path.endsWith('/pulls')) {
      return json(res, 200, [{
        number: 3,
        title: '离线测试 PR',
        state: 'open',
        user: { login: 'yeswater' },
        head: { ref: 'feature' },
        base: { ref: 'main' },
      }])
    }
    json(res, 404, { message: 'not found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { apiBase: `http://127.0.0.1:${port}/api/v5`, auths, writes }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

async function setup() {
  const fake = await fixture()
  const harness = await createHarness({
    gitee: { apiBase: fake.apiBase, allowPrivateHost: true },
  })
  harnesses.push(harness)
  return { harness, base: harness.ctx.web.url, auths: fake.auths, writes: fake.writes }
}

function put(base: string, path: string, body: unknown, method = 'PUT') {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('gitee web', () => {
  it('stores the token write-only and keeps it across partial updates', async () => {
    const { base } = await setup()

    const saved = await put(base, '/api/gitee/settings', {
      token: 'secret-token',
      owner: 'yeswater',
      visibility: 'public',
    })
    expect(saved.status).toBe(200)
    const savedBody = await saved.json() as Record<string, unknown>
    expect(savedBody).toMatchObject({ hasToken: true, owner: 'yeswater', visibility: 'public' })
    expect(JSON.stringify(savedBody)).not.toContain('secret-token')

    const partial = await put(base, '/api/gitee/settings', { owner: 'other' })
    expect(await partial.json()).toMatchObject({ hasToken: true, owner: 'other' })

    const read = await (await fetch(`${base}/api/gitee/settings`)).json() as Record<string, unknown>
    expect(read.hasToken).toBe(true)
    expect(JSON.stringify(read)).not.toContain('secret-token')

    const cleared = await put(base, '/api/gitee/settings', { clearToken: true })
    expect(await cleared.json()).toMatchObject({ hasToken: false })
  })

  it('validates the token against /user and passes it as a header', async () => {
    const { base, auths } = await setup()
    await put(base, '/api/gitee/settings', { token: 'secret-token' })

    const tested = await put(base, '/api/gitee/test', {}, 'POST')
    expect(tested.status).toBe(200)
    expect(await tested.json()).toMatchObject({ account: { login: 'yeswater', name: 'Yes Water' } })
    expect(auths.at(-1)).toBe('token secret-token')
  })

  it('serves read-only repository, issue and pull data', async () => {
    const { base } = await setup()
    await put(base, '/api/gitee/settings', { token: 'secret-token' })

    const repos = await (await fetch(`${base}/api/gitee/repos`)).json() as {
      items: Array<{ fullName: string }>
    }
    expect(repos.items[0].fullName).toBe('yeswater/ruobai-harness')

    const repo = await (await fetch(`${base}/api/gitee/repos/yeswater/ruobai-harness`)).json() as {
      fullName: string; defaultBranch: string
    }
    expect(repo).toMatchObject({ fullName: 'yeswater/ruobai-harness', defaultBranch: 'main' })

    const branches = await (await fetch(`${base}/api/gitee/repos/yeswater/ruobai-harness/branches`)).json() as {
      items: Array<{ name: string; sha: string }>
    }
    expect(branches.items).toEqual([{ name: 'main', sha: 'abcdef123456' }])

    const issues = await (await fetch(`${base}/api/gitee/repos/yeswater/ruobai-harness/issues`)).json() as {
      items: Array<{ number: number; title: string; labels: string[] }>
    }
    expect(issues.items[0]).toMatchObject({ number: 7, title: '离线测试 Issue', labels: ['bug'] })

    const pulls = await (await fetch(`${base}/api/gitee/repos/yeswater/ruobai-harness/pulls`)).json() as {
      items: Array<{ number: number; head: string; base: string }>
    }
    expect(pulls.items[0]).toMatchObject({ number: 3, head: 'feature', base: 'main' })
  })

  it('returns 401 when no token is configured', async () => {
    const { base } = await setup()
    const response = await fetch(`${base}/api/gitee/repos`)
    expect(response.status).toBe(401)
    expect((await response.json() as { error: string }).error).toContain('令牌未配置')
  })

  it('registers read-only agent tools', async () => {
    const { harness, base } = await setup()
    await put(base, '/api/gitee/settings', { token: 'secret-token' })

    expect(harness.ctx.tools.get('gitee_repo')?.readOnly).toBe(true)
    expect(harness.ctx.tools.get('gitee_issue')?.readOnly).toBe(true)
    expect(harness.ctx.tools.get('gitee_pr')?.readOnly).toBe(true)

    const repos = await harness.ctx.tools.invoke('gitee_repo', { action: 'list' })
    expect(repos.isError).toBe(false)
    expect(repos.content).toContain('yeswater/ruobai-harness')

    const issues = await harness.ctx.tools.invoke('gitee_issue', {
      action: 'list',
      owner: 'yeswater',
      repo: 'ruobai-harness',
    })
    expect(issues.isError).toBe(false)
    expect(issues.content).toContain('离线测试 Issue')

    const missing = await harness.ctx.tools.invoke('gitee_repo', { action: 'get' })
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('owner is required')
  })

  it('creates, comments on and closes issues, and manages pull requests', async () => {
    const { base, writes } = await setup()
    await put(base, '/api/gitee/settings', { token: 'secret-token' })

    const created = await put(base, '/api/gitee/repos/yeswater/ruobai-harness/issues', {
      action: 'create',
      title: '新 Issue',
      body: '内容',
      labels: ['bug', 'ui'],
    }, 'POST')
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ number: 8, title: '新 Issue' })
    expect(writes).toContainEqual({
      kind: 'issue-create',
      body: expect.objectContaining({ title: '新 Issue', body: '内容', labels: 'bug,ui' }),
    })

    expect((await put(base, '/api/gitee/repos/yeswater/ruobai-harness/issues', {
      action: 'comment',
      number: 8,
      body: '评论',
    }, 'POST')).status).toBe(200)
    expect(writes).toContainEqual({ kind: 'issue-comment', body: { body: '评论' } })

    const closed = await put(base, '/api/gitee/repos/yeswater/ruobai-harness/issues', {
      action: 'close',
      number: 8,
    }, 'POST')
    expect(closed.status).toBe(200)
    expect(await closed.json()).toMatchObject({ state: 'closed' })
    expect(writes).toContainEqual({ kind: 'issue-close', body: { state: 'closed' } })

    const pull = await put(base, '/api/gitee/repos/yeswater/ruobai-harness/pulls', {
      action: 'create',
      title: '新 PR',
      head: 'feature',
      base: 'main',
      body: '说明',
    }, 'POST')
    expect(pull.status).toBe(200)
    expect(await pull.json()).toMatchObject({ number: 4, head: 'feature', base: 'main' })
    expect(writes).toContainEqual({
      kind: 'pull-create',
      body: expect.objectContaining({ title: '新 PR', head: 'feature', base: 'main' }),
    })

    expect((await put(base, '/api/gitee/repos/yeswater/ruobai-harness/pulls', {
      action: 'comment',
      number: 4,
      body: 'PR 评论',
    }, 'POST')).status).toBe(200)
    expect(writes).toContainEqual({ kind: 'pull-comment', body: { body: 'PR 评论' } })
  })

  it('marks Gitee write tools as approval-gated', async () => {
    const { harness } = await setup()
    expect(harness.ctx.tools.get('gitee_issue_write')?.requiresApproval).toBe(true)
    expect(harness.ctx.tools.get('gitee_pull_write')?.requiresApproval).toBe(true)
    expect(harness.ctx.tools.get('gitee_publish')?.requiresApproval).toBe(true)
    expect(harness.ctx.tools.get('gitee_release')?.requiresApproval).toBe(true)
  })
})
