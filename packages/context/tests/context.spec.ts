import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService from '@ruobai/llm'
import SessionService from '@ruobai/session'
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
})
