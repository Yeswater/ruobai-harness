import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService from '@ruobai/llm'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import ContextService from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('context service', () => {
  it('summarizes older events once the estimate crosses the threshold', async () => {
    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'fake', model: 'fake-1' })
    await llm
    cleanups.push(() => llm.dispose())
    const off = ctx.effect(() => ctx.llm.register({
      name: 'fake',
      models: ['fake-1'],
      async *stream() {
        yield { type: 'text-delta', text: 'summary text' }
        yield { type: 'done', reason: 'stop' }
      },
    }))
    cleanups.push(async () => off())

    const sessions = ctx.plugin(SessionService)
    await sessions
    cleanups.push(() => sessions.dispose())
    const context = ctx.plugin(ContextService, { compactAt: 100, keepRecent: 2 })
    await context
    cleanups.push(() => context.dispose())

    const meta = ctx.sessions.create()
    for (let index = 0; index < 10; index += 1) {
      ctx.sessions.append(meta.id, 'message/user', { id: `m${index}`, text: 'x'.repeat(200), at: index })
    }

    const before = await ctx.context.build(meta.id)
    expect(before.estimatedTokens).toBeGreaterThan(100)

    const info = await ctx.context.maybeCompact(meta.id, { provider: 'fake' })
    expect(info?.upToSeq).toBe(7)
    expect(ctx.sessions.get(meta.id)?.events.some(event => event.type === 'context/summary')).toBe(true)

    const after = await ctx.context.build(meta.id)
    expect(after.system).toContain('Summary of the earlier conversation')
    expect(after.messages).toHaveLength(2)
    expect(after.estimatedTokens).toBeLessThan(before.estimatedTokens)

    const summary = await ctx.context.info(meta.id)
    expect(summary.summaries).toBe(1)
  })

  it('reports a breakdown that separates MCP tools from system tools', async () => {
    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'fake', model: 'fake-1' })
    await llm
    cleanups.push(() => llm.dispose())
    const sessions = ctx.plugin(SessionService)
    await sessions
    cleanups.push(() => sessions.dispose())
    const tools = ctx.plugin(ToolRegistry)
    await tools
    cleanups.push(() => tools.dispose())
    const context = ctx.plugin(ContextService, { compactAt: 1_000 })
    await context
    cleanups.push(() => context.dispose())

    ctx.tools.register({
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
      execute: () => '',
    })
    ctx.tools.register({
      name: 'mcp__fixture__echo',
      description: 'Echo through an MCP server',
      parameters: { type: 'object', properties: {} },
      execute: () => '',
    })

    const meta = ctx.sessions.create()
    ctx.sessions.append(meta.id, 'message/user', { id: 'm1', text: 'hello there', at: 1 })
    await ctx.context.build(meta.id, {
      basePrompt: 'You are a harness.',
      modePrompt: 'Answer carefully.',
      tools: ctx.tools.list(),
    })

    const info = await ctx.context.info(meta.id)
    expect(info.mcpTools).toEqual(['mcp__fixture__echo'])
    expect(info.breakdown.mcpTools).toBeGreaterThan(0)
    expect(info.breakdown.systemTools).toBeGreaterThan(0)
    expect(info.breakdown.systemPrompt).toBeGreaterThan(0)
    expect(info.breakdown.messages).toBeGreaterThan(0)
    expect(info.estimatedTokens).toBe(
      info.breakdown.messages + info.breakdown.systemPrompt
      + info.breakdown.systemTools + info.breakdown.mcpTools,
    )
  })

  it('turns attached images and files into content parts', async () => {
    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'fake', model: 'fake-1' })
    await llm
    cleanups.push(() => llm.dispose())
    const sessions = ctx.plugin(SessionService)
    await sessions
    cleanups.push(() => sessions.dispose())
    const context = ctx.plugin(ContextService, { compactAt: 100_000 })
    await context
    cleanups.push(() => context.dispose())

    const meta = ctx.sessions.create()
    ctx.sessions.append(meta.id, 'message/user', {
      id: 'm1',
      text: '看看',
      at: 1,
      attachments: [
        { id: 'a1', kind: 'image', name: 'shot.png', mime: 'image/png', size: 4, data: 'AAAA' },
        { id: 'a2', kind: 'file', name: 'notes.txt', mime: 'text/plain', size: 5, text: 'hello' },
      ],
    })

    const built = await ctx.context.build(meta.id)
    expect(built.messages).toHaveLength(1)
    expect(built.messages[0]!.content).toEqual([
      { type: 'text', text: '看看' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA', name: 'shot.png' },
      { type: 'file', name: 'notes.txt', mimeType: 'text/plain', text: 'hello' },
    ])
  })
})
