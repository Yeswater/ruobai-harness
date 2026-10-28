import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import SessionJsonl from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!()
})

async function boot(root: string) {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  const jsonl = ctx.plugin(SessionJsonl, { root })
  await jsonl
  cleanups.push(() => jsonl.dispose(), () => sessions.dispose())
  return ctx
}

describe('session jsonl repair', () => {
  it('recovers a file whose header was lost and keeps sequence numbers stable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-jsonl-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const id = 'abc'
    const ts = Date.now() - 1_000
    const events = [
      { seq: 2, ts, type: 'message/user', data: { id: 'u1', text: '画一个鹈鹕骑自行车', at: ts } },
      {
        seq: 3, ts, type: 'context/snapshot',
        data: { workspace: '/tmp/project', provider: 'openai', model: 'deepseek-flash', mode: 'agent', permission: 'full-access' },
      },
      { seq: 4, ts, type: 'message/assistant', data: { id: 'a1', at: ts, parts: [{ type: 'text', text: '好' }] } },
    ]
    await writeFile(join(root, `${id}.jsonl`), events.map(row => JSON.stringify(row)).join('\n') + '\n')

    const ctx = await boot(root)
    const meta = ctx.sessions.get(id)!.meta
    expect(meta.title).toBe('画一个鹈鹕骑自行车')
    expect(meta.workspace).toBe('/tmp/project')
    expect(meta.provider).toBe('openai')
    expect(meta.permission).toBe('full-access')

    const file = await readFile(join(root, `${id}.jsonl`), 'utf8')
    const rows = file.trim().split('\n').map(line => JSON.parse(line))
    expect(rows[0]).toMatchObject({ type: 'session', version: 1, id })
    expect(rows.filter((row: any) => row.type === 'session/title')).toHaveLength(1)
    expect(rows.filter((row: any) => row.type === 'session/meta')).toHaveLength(1)

    // The next append must not collide with an existing seq.
    const appended = ctx.sessions.append(id, 'turn/notice', { kind: 'test' })
    expect(appended.seq).toBe(5)
    await ctx.sessionJsonl.flush()
    const tail = (await readFile(join(root, `${id}.jsonl`), 'utf8')).trim().split('\n').at(-1)
    expect(JSON.parse(tail!)).toMatchObject({ seq: 5, type: 'turn/notice' })
  })

  it('restores the repaired session on the next boot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-jsonl-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'x.jsonl'), [
      JSON.stringify({ type: 'session', version: 1, id: 'x', createdAt: 1 }),
      JSON.stringify({ seq: 0, ts: 2, type: 'session/title', data: { title: '已修复' } }),
      JSON.stringify({ seq: 1, ts: 3, type: 'session/meta', data: { workspace: '/w' } }),
      JSON.stringify({ seq: 2, ts: 4, type: 'message/user', data: { id: 'u', text: 'hi', at: 4 } }),
    ].join('\n') + '\n')

    const ctx = await boot(root)
    expect(ctx.sessions.get('x')!.meta).toMatchObject({ title: '已修复', workspace: '/w' })
  })
})
