import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ToolRegistry from '@ruobai/tools'
import FsTools from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('tool registry and fs tools', () => {
  it('reads files inside the workspace and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbh-fs-'))
    await writeFile(join(root, 'hello.txt'), 'hello world')
    cleanups.push(() => rm(root, { recursive: true, force: true }))

    const ctx = new Context()
    const tools = ctx.plugin(ToolRegistry)
    await tools
    const fsTools = ctx.plugin(FsTools, { root })
    await fsTools
    cleanups.push(() => fsTools.dispose(), () => tools.dispose())

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
})
