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
  const fallback = await mkdtemp(join(tmpdir(), 'rbh-fs-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 'rbh-fs-ws-'))
  cleanups.push(
    () => rm(fallback, { recursive: true, force: true }),
    () => rm(workspace, { recursive: true, force: true }),
  )
  await writeFile(join(workspace, 'only.txt'), 'from workspace')

  const ctx = new Context()
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const approval = ctx.plugin(ApprovalService)
  await approval
  const fsTools = ctx.plugin(FsTools, { root: fallback })
  await fsTools
  cleanups.push(() => fsTools.dispose(), () => approval.dispose(), () => tools.dispose())
  ctx.on('approval/requested', (request: any) => ctx.approval.resolve(request.id, 'allow'))

  return { ctx, fallback, workspace }
}

describe('per-session workspace root', () => {
  it('reads, writes and searches inside the run workspace', async () => {
    const { ctx, fallback, workspace } = await setup()

    const read = await ctx.tools.invoke(
      'read_file',
      { path: 'only.txt' },
      { sessionId: 's1', workspace },
    )
    expect(read).toEqual({ content: 'from workspace', isError: false })

    const escape = await ctx.tools.invoke(
      'read_file',
      { path: '../outside.txt' },
      { sessionId: 's1', workspace },
    )
    expect(escape.isError).toBe(true)
    expect(escape.content).toContain('escapes the workspace')

    const write = await ctx.tools.invoke(
      'write_file',
      { path: 'new.txt', content: 'written' },
      { sessionId: 's1', workspace },
    )
    expect(write.isError).toBe(false)
    expect(await readFile(join(workspace, 'new.txt'), 'utf8')).toBe('written')
    await expect(readFile(join(fallback, 'new.txt'))).rejects.toThrow()

    const search = await ctx.tools.invoke(
      'grep',
      { pattern: 'from workspace' },
      { sessionId: 's1', workspace },
    )
    expect(search.isError).toBe(false)
    expect(search.content).toContain('only.txt:1:from workspace')
  })

  it('falls back to the configured root without a workspace', async () => {
    const { ctx, fallback, workspace } = await setup()
    await writeFile(join(fallback, 'fallback.txt'), 'fallback')

    const result = await ctx.tools.invoke('read_file', { path: 'fallback.txt' })
    expect(result.content).toBe('fallback')
    expect(await readFile(join(workspace, 'only.txt'), 'utf8')).toBe('from workspace')
  })
})
