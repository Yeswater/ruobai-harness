import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService from '@ruobai/llm'
import SessionService from '@ruobai/session'
import WorkspaceService from '@ruobai/workspace'
import ContextService from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'rbh-sections-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const llm = ctx.plugin(LlmService, { provider: 'mock', model: 'mock-1' })
  await llm
  cleanups.push(() => llm.dispose())
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(() => sessions.dispose())
  const workspace = ctx.plugin(WorkspaceService, { root: dir })
  await workspace
  cleanups.push(() => workspace.dispose())
  const context = ctx.plugin(ContextService, { globalRoot: dir })
  await context
  cleanups.push(() => context.dispose())
  const session = ctx.sessions.create({ workspace: dir })
  return { ctx, sessionId: session.id }
}

describe('prompt sections', () => {
  it('renders registered sections between skills and summary, in order', async () => {
    const { ctx, sessionId } = await setup()
    const off = ctx.context.registerSection({
      id: 'demo',
      order: 40,
      stability: 'session',
      render: () => 'DEMO-SECTION',
    })
    cleanups.push(off)

    const built = await ctx.context.build(sessionId, { basePrompt: 'BASE', modePrompt: 'MODE' })
    expect(built.system.indexOf('BASE')).toBeLessThan(built.system.indexOf('MODE'))
    expect(built.system.indexOf('MODE')).toBeLessThan(built.system.indexOf('DEMO-SECTION'))
    expect(built.fingerprint.sections?.map(section => section.id)).toEqual(['base', 'mode', 'demo'])
  })

  it('drops a section when its disposer runs', async () => {
    const { ctx, sessionId } = await setup()
    const off = ctx.context.registerSection({
      id: 'demo',
      order: 40,
      stability: 'session',
      render: () => 'DEMO-SECTION',
    })
    off()
    const built = await ctx.context.build(sessionId)
    expect(built.system).not.toContain('DEMO-SECTION')
  })

  it('truncates a section at maxChars', async () => {
    const { ctx, sessionId } = await setup()
    cleanups.push(ctx.context.registerSection({
      id: 'cap',
      order: 40,
      stability: 'session',
      maxChars: 10,
      render: () => 'x'.repeat(50),
    }))
    const built = await ctx.context.build(sessionId)
    expect(built.system).toContain('x'.repeat(10))
    expect(built.system).not.toContain('x'.repeat(11))
  })

  it('attributes a system break to the section that changed', async () => {
    const { ctx, sessionId } = await setup()
    let text = 'first version'
    cleanups.push(ctx.context.registerSection({
      id: 'demo',
      order: 40,
      stability: 'session',
      render: () => text,
    }))

    await ctx.context.build(sessionId, { record: true })
    text = 'second version'
    const built = await ctx.context.build(sessionId, { record: true })
    expect(built.divergence?.region).toBe('system')
    expect(built.divergence?.section).toBe('demo')
    expect(built.divergence?.reason).toBe('system')
  })

  it('reports a memory refresh as reason "memory"', async () => {
    const { ctx, sessionId } = await setup()
    let text = ''
    cleanups.push(ctx.context.registerSection({
      id: 'memory',
      order: 40,
      stability: 'session',
      render: () => text,
    }))

    await ctx.context.build(sessionId, { record: true })
    text = 'a durable fact'
    const built = await ctx.context.build(sessionId, { record: true })
    expect(built.divergence?.reason).toBe('memory')
    expect(built.divergence?.section).toBe('memory')
  })

  it('keeps a failing section from breaking the build', async () => {
    const { ctx, sessionId } = await setup()
    cleanups.push(ctx.context.registerSection({
      id: 'broken',
      order: 40,
      stability: 'session',
      render: () => {
        throw new Error('boom')
      },
    }))
    const built = await ctx.context.build(sessionId, { basePrompt: 'BASE' })
    expect(built.system).toContain('BASE')
  })
})
