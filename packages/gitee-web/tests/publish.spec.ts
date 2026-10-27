import { execFile } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const exec = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function git(args: string[]) {
  const { stdout } = await exec('git', args, { encoding: 'utf8' })
  return stdout.trim()
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rbh-gitee-publish-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  const work = join(root, 'work')
  await mkdir(work, { recursive: true })
  await git(['init', '-b', 'main', work])
  await git(['-C', work, 'config', 'user.email', 'test@example.com'])
  await git(['-C', work, 'config', 'user.name', 'Test'])
  await writeFile(join(work, 'README.md'), '# demo\n')
  await git(['-C', work, 'add', '.'])
  await git(['-C', work, 'commit', '-m', 'init'])

  const bare = join(root, 'bare', 'yeswater', 'demo.git')
  await mkdir(dirname(bare), { recursive: true })
  await git(['init', '--bare', bare])

  let createdRepo = false
  let release: Record<string, unknown> | undefined
  const requests: string[] = []

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push(`${req.method} ${url.pathname}`)
    const repoBody = {
      full_name: 'yeswater/demo',
      name: 'demo',
      owner: { login: 'yeswater' },
      private: false,
      html_url: 'https://gitee.com/yeswater/demo.git',
      default_branch: 'main',
    }
    if (url.pathname === '/api/v5/user') {
      return json(res, 200, { login: 'yeswater', name: 'Yes Water' })
    }
    if (url.pathname === '/api/v5/user/orgs') {
      return json(res, 200, [])
    }
    if (url.pathname === '/api/v5/user/repos' && req.method === 'POST') {
      createdRepo = true
      return json(res, 201, repoBody)
    }
    if (url.pathname === '/api/v5/repos/yeswater/demo') {
      return createdRepo ? json(res, 200, repoBody) : json(res, 404, { message: 'not found' })
    }
    if (url.pathname === '/api/v5/repos/yeswater/demo/releases/tags/v0.0.1' && req.method === 'GET') {
      return release
        ? json(res, 200, { tag_name: release.tag_name, name: release.name })
        : json(res, 404, { message: 'not found' })
    }
    if (url.pathname === '/api/v5/repos/yeswater/demo/releases' && req.method === 'POST') {
      if (release) return json(res, 400, { message: 'release already exists' })
      readBody(req).then((body) => {
        release = body
        json(res, 201, {
          tag_name: body.tag_name,
          name: body.name,
        })
      })
      return
    }
    json(res, 404, { message: 'not found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const harness = await createHarness({
    gitee: {
      apiBase: `http://127.0.0.1:${port}/api/v5`,
      allowPrivateHost: true,
      remoteTemplate: `file://${root}/bare/{owner}/{repo}.git`,
    },
  })
  cleanups.push(() => harness.dispose())
  await harness.ctx.settings.updateGitee({ token: 'secret-token' })

  return { harness, work, bare, requests, release: () => release, root }
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

describe('gitee publish', () => {
  it('creates the repository, pushes, tags and releases', async () => {
    const { harness, work, bare, requests, release } = await setup()

    const result = await harness.ctx.gitee.publish({
      workspace: work,
      owner: 'yeswater',
      repo: 'demo',
      tag: 'v0.0.1',
      releaseTitle: 'v0.0.1',
      releaseBody: 'notes',
    })

    expect(result.steps.map(step => `${step.name}:${step.status}`)).toEqual([
      '创建仓库:done',
      '配置 remote:done',
      '推送分支:done',
      '创建并推送 tag:done',
      '创建 Release:done',
    ])
    expect(result.url).toBe('https://gitee.com/yeswater/demo')
    expect(result.releaseUrl).toContain('/releases/tag/v0.0.1')

    const head = await git(['-C', work, 'rev-parse', 'HEAD'])
    expect(await git(['--git-dir', bare, 'rev-parse', 'refs/heads/main'])).toBe(head)
    expect(await git(['--git-dir', bare, 'rev-parse', 'refs/tags/v0.0.1'])).toBe(head)

    expect(requests).toContain('POST /api/v5/user/repos')
    expect(requests).toContain('POST /api/v5/repos/yeswater/demo/releases')
    expect(release()).toMatchObject({ tag_name: 'v0.0.1', name: 'v0.0.1', body: 'notes' })

    // Re-publishing the same target is idempotent, including an existing Release.
    const again = await harness.ctx.gitee.publish({
      workspace: work,
      owner: 'yeswater',
      repo: 'demo',
      tag: 'v0.0.1',
      releaseTitle: 'v0.0.1',
      releaseBody: 'notes',
    })
    expect(again.steps.map(step => `${step.name}:${step.status}`)).toEqual([
      '创建仓库:skipped',
      '配置 remote:skipped',
      '推送分支:done',
      '创建并推送 tag:skipped',
      '创建 Release:skipped',
    ])
    expect(again.url).toMatch(/\/yeswater\/demo$/)
    expect(again.url).not.toContain('.git')
    expect(again.releaseUrl).toMatch(/\/yeswater\/demo\/releases\/tag\/v0\.0\.1$/)
  })

  it('refuses to overwrite a conflicting gitee remote', async () => {
    const { harness, work } = await setup()
    await git(['-C', work, 'remote', 'add', 'gitee', 'file:///elsewhere/demo.git'])

    const plan = await harness.ctx.gitee.planPublish({ workspace: work, owner: 'yeswater', repo: 'demo' })
    expect(plan.remote.conflict).toBe(true)

    await expect(harness.ctx.gitee.publish({ workspace: work, owner: 'yeswater', repo: 'demo' }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('previews and reports workspace status over HTTP', async () => {
    const { harness, work } = await setup()
    const session = harness.ctx.chat.create(undefined, 'agent', work)

    const preview = await fetch(`${harness.ctx.web.url}/api/gitee/publish/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, owner: 'yeswater', repo: 'demo' }),
    })
    expect(preview.status).toBe(200)
    const plan = await preview.json() as { repoExists: boolean; branch: string; fullName: string }
    expect(plan).toMatchObject({ repoExists: false, branch: 'main', fullName: 'yeswater/demo' })

    const status = await (await fetch(
      `${harness.ctx.web.url}/api/gitee/status?sessionId=${session.id}`,
    )).json() as { branch: string; suggestedRepo: string; dirty: boolean }
    expect(status).toMatchObject({ branch: 'main', suggestedRepo: 'work', dirty: false })
  })
})
