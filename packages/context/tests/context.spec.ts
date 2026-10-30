import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService from '@ruobai/llm'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import ContextService from '../src/index.ts'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('context window resolution', () => {
  it('finds the model window by id when the session pinned a retired provider', async () => {
    const harness: Harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const ctx = harness.ctx

    await ctx.settings.upsertProvider({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxOutputTokens: 256_000 }],
    })

    // The session still names a provider that no longer exists; only the model
    // id ties it to the configured window.
    const meta = ctx.sessions.create({ provider: 'retired-provider', model: 'deepseek-flash' })
    const info = await ctx.context.info(meta.id)

    expect(info.contextWindow).toBe(1_000_000)
    expect(info.compactAt).toBe(800_000)
  })
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

  it('drops a stopped step that carries only thinking', async () => {
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
    ctx.sessions.append(meta.id, 'message/user', { id: 'm1', text: '开始', at: 1 })
    // 「停止」中断了一个还在思考的回合：这条消息只有 reasoning。
    ctx.sessions.append(meta.id, 'message/assistant', {
      id: 'a1',
      parts: [{ type: 'reasoning', text: '正在分析…' }],
      at: 2,
    })
    ctx.sessions.append(meta.id, 'message/user', { id: 'm2', text: '继续', at: 3 })

    const built = await ctx.context.build(meta.id)
    expect(built.messages.map(message => message.role)).toEqual(['user', 'user'])
    expect(built.messages.map(message => message.content[0])).toEqual([
      { type: 'text', text: '开始' },
      { type: 'text', text: '继续' },
    ])
  })

  it('drops tool calls whose result never arrived and keeps the rest of the step', async () => {
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
    ctx.sessions.append(meta.id, 'message/user', { id: 'm1', text: '看两个文件', at: 1 })
    ctx.sessions.append(meta.id, 'message/assistant', {
      id: 'a1',
      parts: [
        { type: 'text', text: '我先读' },
        { type: 'tool-call', id: 'call-a', name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'tool-call', id: 'call-b', name: 'read_file', arguments: '{"path":"b"}' },
      ],
      at: 2,
    })
    ctx.sessions.append(meta.id, 'tool/result', {
      callId: 'call-a', name: 'read_file', content: 'A', isError: false,
    })
    // `call-b` 在结果落地前被中断；孤立的 tool/result 同样不该出现在请求里。
    ctx.sessions.append(meta.id, 'tool/result', {
      callId: 'call-ghost', name: 'read_file', content: 'B', isError: false,
    })
    ctx.sessions.append(meta.id, 'message/user', { id: 'm2', text: '继续', at: 3 })

    const built = await ctx.context.build(meta.id)
    const assistant = built.messages.find(message => message.role === 'assistant')
    expect(assistant?.content).toEqual([
      { type: 'text', text: '我先读' },
      { type: 'tool-call', id: 'call-a', name: 'read_file', arguments: '{"path":"a"}' },
    ])
    const toolMessages = built.messages.filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.content[0]).toMatchObject({ type: 'tool-result', callId: 'call-a' })
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
