import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService from '@ruobai/llm'
import type { Message } from '@ruobai/llm'
import SessionService from '@ruobai/session'
import type { SessionEvent } from '@ruobai/session'
import ContextService from '../src/index.ts'
import {
  extractSummary,
  isContextOverflow,
  pruneToolOutput,
  pruneToolResults,
  selectCompactionCut,
} from '../src/compaction.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, ts: seq, type, data }
}

function textOf(messages: Message[]) {
  return messages.map(message => message.content
    .map(part => part.type === 'text' ? part.text : '')
    .join('')).join('\n')
}

async function mountContext(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const llm = ctx.plugin(LlmService, { provider: 'fake', model: 'fake-1' })
  await llm
  cleanups.push(() => llm.dispose())
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(() => sessions.dispose())

  const requests: Message[][] = []
  let reply: (messages: Message[]) => string | { error: string } = () => 'summary text'
  let fail = false
  const off = ctx.effect(() => ctx.llm.register({
    name: 'fake',
    models: ['fake-1'],
    async *stream(request) {
      requests.push(request.messages)
      if (fail) yield { type: 'error' as const, message: 'summarizer unavailable' }
      else {
        const result = reply(request.messages)
        if (typeof result === 'string') yield { type: 'text-delta' as const, text: result }
        else yield { type: 'error' as const, message: result.error }
      }
      yield { type: 'done' as const, reason: 'stop' as const }
    },
  }))
  cleanups.push(async () => off())

  const context = ctx.plugin(ContextService, { compactAt: 100, keepRecent: 2, ...config })
  await context
  cleanups.push(() => context.dispose())
  return {
    ctx,
    requests,
    setReply: (next: (messages: Message[]) => string | { error: string }) => { reply = next },
    setFail: (next: boolean) => { fail = next },
  }
}

describe('compaction helpers', () => {
  it('recognizes provider overflow wording', () => {
    expect(isContextOverflow("This model's maximum context length is 128000 tokens")).toBe(true)
    expect(isContextOverflow('context_length_exceeded')).toBe(true)
    expect(isContextOverflow('prompt is too long: 210000 tokens > 200000 maximum')).toBe(true)
    expect(isContextOverflow('request too large for this model')).toBe(true)
    expect(isContextOverflow('unknown llm provider "fake"')).toBe(false)
  })

  it('prunes an oversized tool output by head and tail', () => {
    const content = `HEAD${'x'.repeat(2_000)}TAIL`
    const pruned = pruneToolOutput(content, {
      enabled: true,
      keepRecent: 0,
      thresholdChars: 100,
      headChars: 20,
      tailChars: 20,
    })
    expect(pruned).toContain('HEAD')
    expect(pruned).toContain('TAIL')
    expect(pruned).toContain('已省略')
    expect(pruned!.length).toBeLessThan(content.length)

    expect(pruneToolOutput('short', {
      enabled: true,
      keepRecent: 0,
      thresholdChars: 100,
      headChars: 20,
      tailChars: 20,
    })).toBeNull()
  })

  it('keeps the newest tool results unpruned', () => {
    const events = [
      event(0, 'tool/result', { callId: 'a', name: 'read_file', content: 'x'.repeat(500) }),
      event(1, 'tool/result', { callId: 'b', name: 'read_file', content: 'y'.repeat(500) }),
    ]
    const pruned = pruneToolResults(events, {
      enabled: true,
      keepRecent: 1,
      thresholdChars: 100,
      headChars: 10,
      tailChars: 10,
    })
    expect(pruned.has(0)).toBe(true)
    expect(pruned.has(1)).toBe(false)
  })

  it('never cuts a tool result away from its call', () => {
    const events = [
      event(0, 'message/user', { id: 'u1', text: 'go' }),
      event(1, 'message/assistant', {
        id: 'a1',
        parts: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }],
      }),
      event(2, 'tool/result', { callId: 'c1', name: 'read_file', content: 'x'.repeat(300) }),
      event(3, 'message/user', { id: 'u2', text: 'more' }),
      event(4, 'message/assistant', {
        id: 'a2',
        parts: [{ type: 'tool-call', id: 'c2', name: 'read_file', arguments: '{}' }],
      }),
      event(5, 'tool/result', { callId: 'c2', name: 'read_file', content: 'y'.repeat(300) }),
    ]
    const selection = selectCompactionCut(events, {
      upToSeq: -1,
      retainTokens: 1,
      keepRecent: 1,
      cost: () => 10,
    })
    expect(selection?.upToSeq).toBe(3)
    expect(selection?.keepFromSeq).toBe(4)
  })

  it('prefers a summary block and strips analysis', () => {
    expect(extractSummary('<analysis>thinking</analysis><summary>## Result</summary>')).toBe('## Result')
    expect(extractSummary('<analysis>thinking</analysis>plain')).toBe('plain')
  })
})

describe('context compaction', () => {
  it('prunes old tool output for the model while the log stays intact', async () => {
    const { ctx } = await mountContext({
      compactAt: 1_000_000,
      pruneKeepRecent: 0,
      pruneThreshold: 100,
      pruneHead: 20,
      pruneTail: 20,
    })
    const session = ctx.sessions.create()
    ctx.sessions.append(session.id, 'message/user', { id: 'u1', text: 'read it', at: 1 })
    ctx.sessions.append(session.id, 'message/assistant', {
      id: 'a1',
      parts: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }],
      at: 2,
    })
    const content = `start${'z'.repeat(500)}end`
    ctx.sessions.append(session.id, 'tool/result', {
      callId: 'c1',
      name: 'read_file',
      content,
      at: 3,
    })

    const built = await ctx.context.build(session.id)
    const tool = built.messages.find(message => message.role === 'tool')
    const part = tool?.content[0]
    expect(part?.type).toBe('tool-result')
    if (part?.type === 'tool-result') {
      expect(part.content.length).toBeLessThan(content.length)
      expect(part.content).toContain('已省略')
    }
    expect(ctx.sessions.get(session.id)!.events.at(-1)!.data.content).toBe(content)
    const info = await ctx.context.info(session.id)
    expect(info.prunedToolResults).toBe(1)
  })

  it('compacts below the threshold on demand with a structured prompt', async () => {
    const { ctx, requests, setReply } = await mountContext({ compactAt: 100, keepRecent: 2 })
    setReply(() => '<analysis>draft</analysis><summary>## Primary Request and Intent\n- keep going</summary>')
    const session = ctx.sessions.create()
    for (let index = 0; index < 10; index += 1) {
      ctx.sessions.append(session.id, 'message/user', {
        id: `m${index}`,
        text: `instruction ${index} ${'x'.repeat(300)}`,
        at: index,
      })
    }

    const info = await ctx.context.compactNow(session.id, { focus: 'keep the API stable' })
    expect(info).toBeDefined()
    expect(info!.upToSeq).toBeLessThan(9)

    const summary = ctx.sessions.get(session.id)!.events.find(item => item.type === 'context/summary')
    expect(summary?.data.text).toContain('## Primary Request and Intent')
    expect(summary?.data.text).not.toContain('analysis')

    const prompt = textOf(requests.at(-1)!)
    expect(prompt).toContain('## User Messages')
    expect(prompt).toContain('Focus especially on: keep the API stable')

    const built = await ctx.context.build(session.id)
    expect(built.system).toContain('<compacted-summary>')
    expect(built.messages.length).toBeLessThanOrEqual(3)
  })

  it('keeps the turn alive when summarization fails and disables auto after three failures', async () => {
    const { ctx, setFail } = await mountContext({ compactAt: 100, keepRecent: 2 })
    setFail(true)
    const session = ctx.sessions.create()
    for (let index = 0; index < 10; index += 1) {
      ctx.sessions.append(session.id, 'message/user', {
        id: `m${index}`,
        text: `instruction ${index} ${'x'.repeat(300)}`,
        at: index,
      })
    }

    await expect(ctx.context.maybeCompact(session.id)).resolves.toBeUndefined()
    await expect(ctx.context.maybeCompact(session.id)).resolves.toBeUndefined()
    await expect(ctx.context.maybeCompact(session.id)).resolves.toBeUndefined()

    const info = await ctx.context.info(session.id)
    expect(info.compaction.failures).toBe(3)
    expect(info.compaction.disabled).toBe(true)
    expect(info.compaction.lastError).toContain('summarizer unavailable')
    expect(ctx.sessions.get(session.id)!.events.some(item => item.type === 'context/summary')).toBe(false)
  })

  it('shrinks the summarizer input when the checkpoint request itself overflows', async () => {
    const { ctx, requests, setReply } = await mountContext({ compactAt: 100, keepRecent: 2 })
    let summaryCalls = 0
    setReply((messages) => {
      const system = messages[0]?.role === 'system'
        ? messages[0].content.map(part => part.type === 'text' ? part.text : '').join('')
        : ''
      if (!system.includes('compaction engine')) return 'unexpected main call'
      summaryCalls += 1
      if (summaryCalls === 1) return { error: "This model's maximum context length is 8000 tokens" }
      return '## Primary Request and Intent\n- continue'
    })
    const session = ctx.sessions.create()
    for (let index = 0; index < 12; index += 1) {
      ctx.sessions.append(session.id, 'message/user', {
        id: `m${index}`,
        text: `instruction ${index} ${'x'.repeat(300)}`,
        at: index,
      })
    }

    const info = await ctx.context.compactNow(session.id)
    expect(info).toBeDefined()
    expect(summaryCalls).toBe(2)
    expect(JSON.stringify(requests[1]).length).toBeLessThan(JSON.stringify(requests[0]).length)
    expect(ctx.sessions.get(session.id)!.events.some(item => item.type === 'context/summary')).toBe(true)
  })

  it('calibrates the estimate with provider usage', async () => {
    const { ctx } = await mountContext({ compactAt: 1_000_000 })
    const session = ctx.sessions.create()
    ctx.sessions.append(session.id, 'message/user', { id: 'u1', text: 'x'.repeat(600), at: 1 })

    const before = await ctx.context.build(session.id)
    ctx.context.observeUsage(session.id, before.estimatedTokens, before.estimatedTokens * 2)
    const after = await ctx.context.build(session.id)
    expect(after.estimatedTokens).toBeGreaterThan(before.estimatedTokens)

    const info = await ctx.context.info(session.id)
    expect(info.calibration).toBeGreaterThan(1)
    expect(info.estimatedTokens).toBe(
      info.breakdown.messages + info.breakdown.systemPrompt
      + info.breakdown.systemTools + info.breakdown.mcpTools,
    )
  })
})
