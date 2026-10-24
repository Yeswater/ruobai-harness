import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import CheckpointsService from '@ruobai/checkpoints'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rbh-checkpoints-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  const checkpoints = ctx.plugin(CheckpointsService, {
    root,
    store: join(root, '.store'),
    maxBytes: 1_024,
  })
  await checkpoints
  cleanups.push(() => checkpoints.dispose(), () => sessions.dispose())

  const session = ctx.sessions.create({ title: 'test' })
  return { ctx, root, sessionId: session.id }
}

describe('checkpoints', () => {
  it('restores an overwritten file and clears the change', async () => {
    const { ctx, root, sessionId } = await setup()
    await writeFile(join(root, 'a.txt'), 'before')

    await ctx.checkpoints.capture({
      sessionId,
      path: 'a.txt',
      tool: 'write_file',
      callId: 'call_1',
      before: Buffer.from('before'),
      beforeExisted: true,
      beforeBytes: 6,
      after: Buffer.from('after'),
      diff: 'diff',
    })
    await writeFile(join(root, 'a.txt'), 'after')

    expect(ctx.checkpoints.changes(sessionId)).toMatchObject([
      { path: 'a.txt', tool: 'write_file', callId: 'call_1', beforeExisted: true },
    ])

    const result = await ctx.checkpoints.revert(sessionId)
    expect(result.reverted).toEqual(['a.txt'])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before')
    expect(ctx.checkpoints.changes(sessionId)).toEqual([])
  })

  it('deletes a file that did not exist before the change', async () => {
    const { ctx, root, sessionId } = await setup()

    await ctx.checkpoints.capture({
      sessionId,
      path: 'new.txt',
      tool: 'write_file',
      beforeExisted: false,
      after: Buffer.from('new'),
    })
    await writeFile(join(root, 'new.txt'), 'new')

    const result = await ctx.checkpoints.revert(sessionId)
    expect(result.reverted).toEqual(['new.txt'])
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
  })

  it('reverts only changes after a sequence number', async () => {
    const { ctx, root, sessionId } = await setup()
    await writeFile(join(root, 'a.txt'), 'one')

    await ctx.checkpoints.capture({
      sessionId, path: 'a.txt', tool: 'edit_file',
      before: Buffer.from('one'), beforeExisted: true, after: Buffer.from('two'),
    })
    await writeFile(join(root, 'a.txt'), 'two')

    await ctx.checkpoints.capture({
      sessionId, path: 'a.txt', tool: 'edit_file',
      before: Buffer.from('two'), beforeExisted: true, after: Buffer.from('three'),
    })
    await writeFile(join(root, 'a.txt'), 'three')

    const [first] = ctx.checkpoints.changes(sessionId)
    await ctx.checkpoints.revert(sessionId, first!.seq)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two')
    expect(ctx.checkpoints.changes(sessionId)).toHaveLength(1)

    await ctx.checkpoints.revert(sessionId)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one')
  })

  it('refuses to overwrite a file changed outside the checkpoint', async () => {
    const { ctx, root, sessionId } = await setup()
    await writeFile(join(root, 'a.txt'), 'before')

    await ctx.checkpoints.capture({
      sessionId, path: 'a.txt', tool: 'write_file',
      before: Buffer.from('before'), beforeExisted: true, after: Buffer.from('after'),
    })
    await writeFile(join(root, 'a.txt'), 'external')

    const result = await ctx.checkpoints.revert(sessionId)
    expect(result.reverted).toEqual([])
    expect(result.skipped[0]).toMatchObject({ path: 'a.txt', reason: /changed since/ })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('external')
  })

  it('reports changes whose original was too large to snapshot', async () => {
    const { ctx, root, sessionId } = await setup()
    await writeFile(join(root, 'big.txt'), 'after')

    await ctx.checkpoints.capture({
      sessionId, path: 'big.txt', tool: 'write_file',
      beforeExisted: true, beforeBytes: 2_000, skipped: 'too-large',
      after: Buffer.from('after'),
    })

    const result = await ctx.checkpoints.revert(sessionId)
    expect(result.reverted).toEqual([])
    expect(result.skipped[0]!.reason).toContain('too large')
    expect(await readFile(join(root, 'big.txt'), 'utf8')).toBe('after')
  })

  it('reverts against the session workspace', async () => {
    const { ctx } = await setup()
    const workspace = await mkdtemp(join(tmpdir(), 'rbh-checkpoints-ws-'))
    cleanups.push(() => rm(workspace, { recursive: true, force: true }))
    await writeFile(join(workspace, 'a.txt'), 'before')

    const session = ctx.sessions.create({ title: 'workspace', workspace })
    await ctx.checkpoints.capture({
      sessionId: session.id,
      path: 'a.txt',
      tool: 'write_file',
      before: Buffer.from('before'),
      beforeExisted: true,
      after: Buffer.from('after'),
    })
    await writeFile(join(workspace, 'a.txt'), 'after')

    const result = await ctx.checkpoints.revert(session.id)
    expect(result.reverted).toEqual(['a.txt'])
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('before')
  })
})
