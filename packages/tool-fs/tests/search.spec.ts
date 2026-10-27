import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  const root = await mkdtemp(join(tmpdir(), 'rbh-search-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  await mkdir(join(root, 'src', 'deep'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'const needle = 1\nexport default needle\n')
  await writeFile(join(root, 'src', 'deep', 'b.ts'), '// needle here\n')
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'needle\n')
  await writeFile(join(root, 'README.md'), 'Needle upper\n')
  await writeFile(join(root, 'bin.dat'), Buffer.from([0, 110, 101, 101, 100, 108, 101]))

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

describe('grep and glob tools', () => {
  it('searches text files and skips ignored and binary files', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.invoke('grep', { pattern: 'needle' })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('src/a.ts:1:const needle = 1')
    expect(result.content).toContain('src/a.ts:2:export default needle')
    expect(result.content).toContain('src/deep/b.ts:1:// needle here')
    expect(result.content).not.toContain('node_modules')
    expect(result.content).not.toContain('bin.dat')
    expect(result.content).not.toContain('README.md')
  })

  it('supports case-insensitive and fixed searches', async () => {
    const { ctx } = await setup()
    const insensitive = await ctx.tools.invoke('grep', { pattern: 'needle', caseSensitive: false })
    expect(insensitive.content).toContain('README.md:1:Needle upper')

    const fixed = await ctx.tools.invoke('grep', { pattern: 'needle =', fixed: true })
    expect(fixed.content).toContain('src/a.ts:1:const needle = 1')
    expect(fixed.content).not.toContain('src/deep/b.ts')
  })

  it('filters by path and glob', async () => {
    const { ctx } = await setup()
    const scoped = await ctx.tools.invoke('grep', { pattern: 'needle', path: 'src', glob: 'src/**/*.ts' })
    expect(scoped.content).toContain('src/a.ts:1')
    expect(scoped.content).toContain('src/deep/b.ts:1')
    expect(scoped.content).not.toContain('README.md')
  })

  it('lists files with segment-aware globs', async () => {
    const { ctx } = await setup()

    const flat = await ctx.tools.invoke('glob', { pattern: 'src/*.ts' })
    expect(flat.content).toBe('src/a.ts')

    const deep = await ctx.tools.invoke('glob', { pattern: 'src/**/*.ts' })
    expect(deep.content.split('\n')).toEqual(['src/a.ts', 'src/deep/b.ts'])

    const markdown = await ctx.tools.invoke('glob', { pattern: '**/*.md' })
    expect(markdown.content).toBe('README.md')
  })

  it('reports invalid patterns and truncation', async () => {
    const { ctx } = await setup()

    const invalid = await ctx.tools.invoke('grep', { pattern: '[' })
    expect(invalid.isError).toBe(true)
    expect(invalid.content).toContain('invalid pattern')

    const capped = await ctx.tools.invoke('grep', { pattern: 'needle', maxResults: 1 })
    expect(capped.content).toContain('truncated at 1')
  })

  it('rejects paths outside the workspace', async () => {
    const { ctx } = await setup()
    const escape = await ctx.tools.invoke('grep', { pattern: 'needle', path: '../etc' })
    expect(escape.isError).toBe(true)
    expect(escape.content).toContain('escapes the workspace')
  })

  it('streams files above maxBytes instead of skipping them', async () => {
    const { ctx, root } = await setup()
    // Default read cap is 64 KiB; both files sit above it.
    await writeFile(join(root, 'big.log'), `${'x'.repeat(70_000)}\nneedle near the end\n`)
    await writeFile(join(root, 'big.bin'), Buffer.concat([
      Buffer.from([0]),
      Buffer.alloc(70_000, 0x78),
      Buffer.from('\nneedle in binary\n'),
    ]))

    const text = await ctx.tools.invoke('grep', { pattern: 'needle near the end' })
    expect(text.isError).toBe(false)
    expect(text.content).toContain('big.log:2:needle near the end')

    const binary = await ctx.tools.invoke('grep', { pattern: 'needle in binary' })
    expect(binary.content).toContain('No matches')
  })
})
