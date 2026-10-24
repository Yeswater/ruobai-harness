import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ApprovalService from '@ruobai/approval'
import { Context } from '@ruobai/cordis'
import ToolRegistry from '@ruobai/tools'
import FsTools from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rbh-fs-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  const ctx = new Context()
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const approval = ctx.plugin(ApprovalService)
  await approval
  const fsTools = ctx.plugin(FsTools, { root })
  await fsTools
  cleanups.push(() => fsTools.dispose(), () => approval.dispose(), () => tools.dispose())
  return { ctx, root }
}

function nextRequest(ctx: Context) {
  return new Promise<any>((resolve) => {
    ctx.once('approval/requested', resolve)
  })
}

describe('tool registry and fs tools', () => {
  it('reports normalized workspace paths for approval rules', async () => {
    const { ctx } = await setup()
    const subject = ctx.tools.get('write_file')!.approvalSubject!({ path: './src/../src/a.ts' }, {})
    expect(subject).toEqual({ kind: 'path', value: 'src/a.ts' })
    expect(() => ctx.tools.get('edit_file')!.approvalSubject!({ path: '../outside' }, {})).toThrow(/escapes/)
  })

  it('reads files inside the workspace and rejects traversal', async () => {
    const { ctx, root } = await setup()
    await writeFile(join(root, 'hello.txt'), 'hello world')

    const ok = await ctx.tools.invoke('read_file', { path: 'hello.txt' })
    expect(ok).toEqual({ content: 'hello world', isError: false })

    const escape = await ctx.tools.invoke('read_file', { path: '../../etc/passwd' })
    expect(escape.isError).toBe(true)
    expect(escape.content).toContain('escapes the workspace')

    const unknown = await ctx.tools.invoke('nope', {})
    expect(unknown.isError).toBe(true)

    const listed = await ctx.tools.invoke('list_dir', {})
    expect(listed.content).toContain('hello.txt')
  })

  it('previews and writes files after approval', async () => {
    const { ctx, root } = await setup()

    const requested = nextRequest(ctx)
    const pending = ctx.tools.invoke('write_file', { path: 'notes/a.txt', content: 'hello' })
    const request = await requested
    expect(request.tool).toBe('write_file')
    expect(request.summary).toContain('new file')
    expect(request.diff).toContain('+hello')

    ctx.approval.resolve(request.id, 'allow')
    const result = await pending
    expect(result.isError).toBe(false)
    expect(await readFile(join(root, 'notes/a.txt'), 'utf8')).toBe('hello')
  })

  it('denies writes without touching the file', async () => {
    const { ctx, root } = await setup()

    const requested = nextRequest(ctx)
    const pending = ctx.tools.invoke('write_file', { path: 'blocked.txt', content: 'nope' })
    const request = await requested
    ctx.approval.resolve(request.id, 'deny')
    const result = await pending
    expect(result.isError).toBe(true)
    await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow()
  })

  it('replaces exactly one occurrence with a diff preview', async () => {
    const { ctx, root } = await setup()
    await writeFile(join(root, 'edit.txt'), 'alpha\nbeta\ngamma')

    const requested = nextRequest(ctx)
    const pending = ctx.tools.invoke('edit_file', {
      path: 'edit.txt',
      oldText: 'beta',
      newText: 'BETA',
    })
    const request = await requested
    expect(request.diff).toContain('-beta')
    expect(request.diff).toContain('+BETA')

    ctx.approval.resolve(request.id, 'allow')
    await pending
    expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('alpha\nBETA\ngamma')

    const ambiguousRequest = nextRequest(ctx)
    const ambiguous = ctx.tools.invoke('edit_file', {
      path: 'edit.txt',
      oldText: 'a',
      newText: 'A',
    })
    const second = await ambiguousRequest
    ctx.approval.resolve(second.id, 'allow')
    const result = await ambiguous
    expect(result.isError).toBe(true)
    expect(result.content).toContain('more than once')
  })
})
