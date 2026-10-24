import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import CheckpointsService from '@ruobai/checkpoints'
import CheckpointsWeb from '@ruobai/checkpoints-web'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import WebServer from '@ruobai/web-server'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rbh-checkpoints-web-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  const checkpoints = ctx.plugin(CheckpointsService, {
    root,
    store: join(root, '.store'),
  })
  await checkpoints
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web
  const routes = ctx.plugin(CheckpointsWeb)
  await routes
  cleanups.push(() => routes.dispose(), () => web.dispose(), () => checkpoints.dispose(), () => sessions.dispose())

  const session = ctx.sessions.create({ title: 'api' })
  return { ctx, root, sessionId: session.id, base: ctx.web.url }
}

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json() as any }
}

describe('checkpoints API', () => {
  it('lists changes and reverts them', async () => {
    const { ctx, root, sessionId, base } = await setup()
    await writeFile(join(root, 'a.txt'), 'before')

    await ctx.checkpoints.capture({
      sessionId,
      path: 'a.txt',
      tool: 'write_file',
      before: Buffer.from('before'),
      beforeExisted: true,
      after: Buffer.from('after'),
      diff: '--- a.txt\n+++ a.txt\n-before\n+after',
    })
    await writeFile(join(root, 'a.txt'), 'after')

    const listed = await call(`${base}/api/checkpoints/${sessionId}`)
    expect(listed.status).toBe(200)
    expect(listed.body.changes).toHaveLength(1)
    expect(listed.body.changes[0]).toMatchObject({ path: 'a.txt', tool: 'write_file' })

    const reverted = await call(`${base}/api/checkpoints/${sessionId}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(reverted.status).toBe(200)
    expect(reverted.body.reverted).toEqual(['a.txt'])

    const empty = await call(`${base}/api/checkpoints/${sessionId}`)
    expect(empty.body.changes).toEqual([])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before')
  })

  it('returns 404 for an unknown session', async () => {
    const { base } = await setup()
    const result = await call(`${base}/api/checkpoints/missing`)
    expect(result.status).toBe(404)
  })
})
