import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService, { type LlmProvider, type StreamChunk } from '../src/index.ts'

describe('llm service', () => {
  it('dispatches to the requested provider and fills the default model', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(LlmService, { provider: 'fake', model: 'fake-1' })
    await fiber

    const provider: LlmProvider = {
      name: 'fake',
      models: ['fake-1'],
      async *stream(request) {
        yield { type: 'text-delta', text: `[${request.model}]` }
        yield { type: 'done', reason: 'stop' }
      },
    }
    const off = ctx.effect(() => ctx.llm.register(provider))

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'text-delta', text: '[fake-1]' },
      { type: 'done', reason: 'stop' },
    ])

    const completion = await ctx.llm.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    expect(completion.content).toBe('[fake-1]')

    off()
    await fiber.dispose()
  })

  it('surfaces an unknown provider as an error chunk', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(LlmService, { provider: 'missing', model: 'x' })
    await fiber

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ messages: [] })) chunks.push(chunk)
    expect(chunks[0]).toEqual({ type: 'error', message: 'unknown llm provider "missing"' })

    await fiber.dispose()
  })

  it('keeps provider registration scoped to the owning effect', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(LlmService, { provider: 'fake', model: 'fake-1' })
    await fiber

    const provider: LlmProvider = { name: 'fake', async *stream() { yield { type: 'done' } } }
    const off = ctx.effect(() => ctx.llm.register(provider))
    expect(ctx.llm.list().map(item => item.name)).toEqual(['fake'])
    off()
    expect(ctx.llm.list()).toEqual([])

    await fiber.dispose()
  })
})
