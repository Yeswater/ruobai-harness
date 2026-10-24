import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ApprovalService from '@ruobai/approval'
import CheckpointsService from '@ruobai/checkpoints'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import FsTools from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rbh-fs-capture-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  const checkpoints = ctx.plugin(CheckpointsService, {
    root,
    store: join(root, '.store'),
    maxBytes: 65_536,
  })
  await checkpoints
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const approval = ctx.plugin(ApprovalService)
  await approval
  const fsTools = ctx.plugin(FsTools, { root })
  await fsTools
  cleanups.push(
    () => fsTools.dispose(),
    () => approval.dispose(),
    () => tools.dispose(),
    () => checkpoints.dispose(),
    () => sessions.dispose(),
  )

  ctx.on('approval/requested', (request: any) => ctx.approval.resolve(request.id, 'allow'))
  const session = ctx.sessions.create({ title: 'capture' })
  return { ctx, root, sessionId: session.id }
}

describe('fs tool checkpoints', () => {
  it('records writes and edits, then restores the original state', async () => {
    const { ctx, root, sessionId } = await setup()

    const created = await ctx.tools.invoke(
      'write_file',
      { path: 'notes/a.txt', content: 'hello\n' },
      { sessionId, callId: 'call_create' },
    )
    expect(created.isError).toBe(false)

    const changes = ctx.checkpoints.changes(sessionId)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      path: 'notes/a.txt',
      tool: 'write_file',
      callId: 'call_create',
      beforeExisted: false,
    })
    expect(changes[0]!.diff).toContain('+hello')

    const edited = await ctx.tools.invoke(
      'edit_file',
      { path: 'notes/a.txt', oldText: 'hello', newText: 'world' },
      { sessionId, callId: 'call_edit' },
    )
    expect(edited.isError).toBe(false)
    expect(ctx.checkpoints.changes(sessionId)).toHaveLength(2)
    expect(await readFile(join(root, 'notes/a.txt'), 'utf8')).toBe('world\n')

    const result = await ctx.checkpoints.revert(sessionId)
    expect(result.reverted).toEqual(['notes/a.txt'])
    await expect(readFile(join(root, 'notes/a.txt'))).rejects.toThrow()
    expect(ctx.checkpoints.changes(sessionId)).toEqual([])
  })

  it('keeps working when checkpoints are not mounted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-fs-capture-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))

    const ctx = new Context()
    const tools = ctx.plugin(ToolRegistry)
    await tools
    const approval = ctx.plugin(ApprovalService)
    await approval
    const fsTools = ctx.plugin(FsTools, { root })
    await fsTools
    cleanups.push(() => fsTools.dispose(), () => approval.dispose(), () => tools.dispose())
    ctx.on('approval/requested', (request: any) => ctx.approval.resolve(request.id, 'allow'))

    const result = await ctx.tools.invoke('write_file', { path: 'a.txt', content: 'ok' }, { sessionId: 's1' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ok')
  })
})
