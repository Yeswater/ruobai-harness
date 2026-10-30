import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import { DRAFT_EVENT, distill } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rbu-drafts-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(() => sessions.dispose())
  const meta = ctx.sessions.create({ title: 'draft' })
  return { ctx, root, sessionId: meta.id }
}

describe('skill distiller', () => {
  it('writes a draft from a successful session and records the event', async () => {
    const { ctx, root, sessionId } = await setup()
    ctx.sessions.append(sessionId, 'message/user', { id: 'm1', text: '把首页改成 SSR 并跑通测试' })
    ctx.sessions.append(sessionId, 'tool/result', { callId: 'c1', name: 'read_file', content: 'ok', isError: false })
    ctx.sessions.append(sessionId, 'file/change', {
      path: 'src/app.ts', tool: 'edit_file', beforeExisted: true, afterBytes: 10, at: 1,
    })

    const draft = await distill(ctx, sessionId, 0, root)
    expect(draft).toBeTruthy()

    const body = await readFile(join(root, draft!.slug, 'SKILL.md'), 'utf8')
    expect(body).toContain('把首页改成 SSR 并跑通测试')
    expect(body).toContain('src/app.ts')
    expect(body).toContain('read_file')
    expect(body).toContain('status: draft')
    expect(body).toContain(`source: session:${sessionId}`)
    expect(ctx.sessions.get(sessionId)!.events.some(event => event.type === DRAFT_EVENT)).toBe(true)
  })

  it('skips a session with no goal', async () => {
    const { ctx, root, sessionId } = await setup()
    ctx.sessions.append(sessionId, 'tool/result', { callId: 'c1', name: 'bash', content: 'ok', isError: false })
    expect(await distill(ctx, sessionId, 0, root)).toBeUndefined()
  })

  it('skips a session with no successful work', async () => {
    const { ctx, root, sessionId } = await setup()
    ctx.sessions.append(sessionId, 'message/user', { id: 'm1', text: '试试看' })
    ctx.sessions.append(sessionId, 'tool/result', { callId: 'c1', name: 'bash', content: 'boom', isError: true })
    expect(await distill(ctx, sessionId, 0, root)).toBeUndefined()
  })

  it('ignores events before the requested seq', async () => {
    const { ctx, root, sessionId } = await setup()
    ctx.sessions.append(sessionId, 'message/user', { id: 'm1', text: '旧的目标' })
    ctx.sessions.append(sessionId, 'tool/result', { callId: 'c1', name: 'bash', content: 'ok', isError: false })
    const draft = await distill(ctx, sessionId, 2, root)
    expect(draft).toBeUndefined()
  })
})
