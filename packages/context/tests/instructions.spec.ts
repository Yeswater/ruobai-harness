import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService from '@ruobai/llm'
import SessionService from '@ruobai/session'
import WorkspaceService from '@ruobai/workspace'
import ContextService from '../src/index.ts'
import {
  discoverInstructionFiles, renderInstructions, type InstructionFile,
} from '../src/instructions.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('instruction discovery', () => {
  it('merges global, project .ruobai and workspace files in order', async () => {
    const globalRoot = await tempDir('rbh-global-')
    const root = await tempDir('rbh-project-')
    await writeFile(join(globalRoot, 'AGENTS.md'), 'global rules')
    await mkdir(join(root, '.ruobai'))
    await writeFile(join(root, '.ruobai', 'AGENTS.md'), 'project rules')
    await writeFile(join(root, 'AGENTS.md'), 'workspace rules')
    await writeFile(join(root, 'AGENTS.local.md'), 'local overlay')

    const files = await discoverInstructionFiles({ root, globalRoot })
    expect(files.map(file => file.display)).toEqual([
      '~/.ruobai/AGENTS.md',
      '.ruobai/AGENTS.md',
      'AGENTS.md',
      'AGENTS.local.md',
    ])
    expect(files.map(file => file.content)).toEqual([
      'global rules',
      'project rules',
      'workspace rules',
      'local overlay',
    ])
  })

  it('collapses duplicate bodies onto the most specific file', async () => {
    const globalRoot = await tempDir('rbh-global-')
    const root = await tempDir('rbh-project-')
    await writeFile(join(globalRoot, 'CLAUDE.md'), 'shared rules')
    await mkdir(join(root, '.ruobai'))
    await writeFile(join(root, '.ruobai', 'CLAUDE.md'), 'shared rules')
    await writeFile(join(root, 'AGENTS.md'), 'root rules')

    const files = await discoverInstructionFiles({ root, globalRoot })
    expect(files.map(file => file.display)).toEqual(['.ruobai/CLAUDE.md', 'AGENTS.md'])
  })

  it('ignores missing directories and unsafe files', async () => {
    const root = await tempDir('rbh-project-')
    const files = await discoverInstructionFiles({ root, globalRoot: join(root, 'missing') })
    expect(files).toEqual([])
  })

  it('keeps the most specific blocks when the budget is tight', () => {
    const files: InstructionFile[] = [
      { path: '/g/AGENTS.md', display: '~/.ruobai/AGENTS.md', content: 'g'.repeat(400), bytes: 400 },
      { path: '/p/AGENTS.md', display: 'AGENTS.md', content: 'p'.repeat(400), bytes: 400 },
    ]
    const rendered = renderInstructions(files, 300)
    expect(rendered.truncated).toBe(true)
    expect(rendered.text).toContain('# Instructions from AGENTS.md')
    expect(rendered.text).toContain('instructions truncated')
  })

  it('feeds the system prompt and exposes the loaded files', async () => {
    const globalRoot = await tempDir('rbh-global-')
    const root = await tempDir('rbh-project-')
    await writeFile(join(globalRoot, 'AGENTS.md'), 'use tabs')
    await mkdir(join(root, '.ruobai'))
    await writeFile(join(root, '.ruobai', 'agent.md'), 'project convention')

    const ctx = new Context()
    const sessions = ctx.plugin(SessionService)
    await sessions
    cleanups.push(() => sessions.dispose())
    const llm = ctx.plugin(LlmService, {})
    await llm
    cleanups.push(() => llm.dispose())
    const workspace = ctx.plugin(WorkspaceService, { root })
    await workspace
    cleanups.push(() => workspace.dispose())
    const context = ctx.plugin(ContextService, {
      compactAt: 1_000_000,
      globalRoot,
      instructionsTtlMs: 0,
    })
    await context
    cleanups.push(() => context.dispose())

    const session = ctx.sessions.create({ title: 'instructions', workspace: root })
    const built = await ctx.context.build(session.id, { basePrompt: 'BASE' })
    expect(built.system).toContain('BASE')
    expect(built.system).toContain('# Instructions from ~/.ruobai/AGENTS.md\nuse tabs')
    expect(built.system).toContain('# Instructions from .ruobai/agent.md\nproject convention')

    const info = await ctx.context.instructionInfo(session.id)
    expect(info.files.map(file => file.display)).toEqual([
      '~/.ruobai/AGENTS.md',
      '.ruobai/agent.md',
    ])
    expect(info.truncated).toBe(false)
  })

  it('scopes instructions to each session workspace', async () => {
    const globalRoot = await tempDir('rbh-global-')
    const first = await tempDir('rbh-first-')
    const second = await tempDir('rbh-second-')
    await writeFile(join(globalRoot, 'AGENTS.md'), 'global')
    await writeFile(join(first, 'AGENTS.md'), 'first workspace')
    await writeFile(join(second, 'AGENTS.md'), 'second workspace')

    const ctx = new Context()
    const sessions = ctx.plugin(SessionService)
    await sessions
    cleanups.push(() => sessions.dispose())
    const llm = ctx.plugin(LlmService, {})
    await llm
    cleanups.push(() => llm.dispose())
    const workspace = ctx.plugin(WorkspaceService, { root: first })
    await workspace
    cleanups.push(() => workspace.dispose())
    const context = ctx.plugin(ContextService, {
      compactAt: 1_000_000,
      globalRoot,
      instructionsTtlMs: 0,
    })
    await context
    cleanups.push(() => context.dispose())

    const a = ctx.sessions.create({ title: 'a', workspace: first })
    const b = ctx.sessions.create({ title: 'b', workspace: second })
    expect((await ctx.context.build(a.id)).system).toContain('first workspace')
    expect((await ctx.context.build(b.id)).system).toContain('second workspace')
    expect((await ctx.context.build(b.id)).system).not.toContain('first workspace')
  })
})
