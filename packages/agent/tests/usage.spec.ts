import { afterEach, describe, expect, it } from 'vitest'
import type { TurnStats } from '@ruobai/chat-protocol'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Streams `count` deltas spaced `gapMs` apart, so the step has a real window. */
async function* paced<T>(count: number, gapMs: number, chunk: T) {
  for (let index = 0; index < count; index += 1) {
    yield chunk
    await sleep(gapMs)
  }
}

async function useScripted(harness: Harness, provider: Parameters<Harness['ctx']['llm']['register']>[0]) {
  harness.ctx.effect(() => harness.ctx.llm.register(provider))
  await harness.ctx.settings.update({ llm: { activeProvider: 'scripted', activeModel: 'scripted-1' } })
}

describe('turn usage', () => {
  it('reports turn usage through agent/usage', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    await useScripted(harness, {
      name: 'scripted',
      async *stream() {
        yield { type: 'text-delta', text: 'hello' }
        await sleep(20)
        yield {
          type: 'done',
          reason: 'stop',
          usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 6 },
        }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const usage = new Promise<TurnStats>((resolve) => {
      harness.ctx.once('agent/usage', (_id, stats) => resolve(stats))
    })
    harness.ctx.chat.send(session.id, 'hi')

    await expect(usage).resolves.toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 6,
      steps: 1,
      outputChars: 5,
    })
    expect(harness.ctx.chat.get(session.id)?.stats).toMatchObject({ outputTokens: 2 })
  })

  it('times only the streaming windows, not the tool round trips between them', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    let step = 0
    await useScripted(harness, {
      name: 'scripted',
      async *stream() {
        step += 1
        if (step === 1) {
          yield* paced(3, 150, { type: 'text-delta' as const, text: 'checking' })
          yield {
            type: 'tool-call' as const,
            id: 'call_list',
            name: 'list_dir',
            arguments: JSON.stringify({ path: '.' }),
          }
          // Idle tail: waiting on the provider must not be billed as generation.
          await sleep(400)
          yield {
            type: 'done' as const,
            reason: 'tool-calls' as const,
            usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20 },
          }
        } else {
          yield* paced(3, 150, { type: 'text-delta' as const, text: 'done' })
          yield {
            type: 'done' as const,
            reason: 'stop' as const,
            usage: { inputTokens: 200, outputTokens: 60, cachedInputTokens: 190 },
          }
        }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const usage = new Promise<TurnStats>((resolve) => {
      harness.ctx.once('agent/usage', (_id, stats) => resolve(stats))
    })
    harness.ctx.chat.send(session.id, 'list the repo')

    const stats = await usage
    expect(stats.steps).toBe(2)
    expect(stats.inputTokens).toBe(300)
    expect(stats.outputTokens).toBe(100)
    expect(stats.cachedInputTokens).toBe(210)
    // Two windows of roughly 300ms each; the 400ms idle tail is excluded.
    expect(stats.streamedOutputTokens).toBe(100)
    expect(stats.generationMs).toBeGreaterThanOrEqual(400)
    expect(stats.generationMs).toBeLessThan(1000)
    expect(stats.ttftMs).toBeLessThan(stats.generationMs!)
  })

  it('leaves steps with a single buffered frame out of the rate', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    await useScripted(harness, {
      name: 'scripted',
      async *stream() {
        yield { type: 'text-delta', text: 'all at once' }
        yield { type: 'text-delta', text: ' and more' }
        yield {
          type: 'done',
          reason: 'stop',
          usage: { inputTokens: 10, outputTokens: 400 },
        }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const usage = new Promise<TurnStats>((resolve) => {
      harness.ctx.once('agent/usage', (_id, stats) => resolve(stats))
    })
    harness.ctx.chat.send(session.id, 'hi')

    const stats = await usage
    expect(stats.outputTokens).toBe(400)
    expect(stats.streamedOutputTokens).toBeUndefined()
  })

  it('starts every turn with a clean stats line', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    await useScripted(harness, {
      name: 'scripted',
      async *stream() {
        yield { type: 'text-delta', text: 'ok' }
        await sleep(20)
        yield { type: 'done', reason: 'stop', usage: { inputTokens: 8, outputTokens: 3 } }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const first = new Promise<void>((resolve) => {
      harness.ctx.once('agent/usage', () => resolve())
    })
    harness.ctx.chat.send(session.id, 'one')
    await first
    expect(harness.ctx.chat.get(session.id)?.stats?.outputTokens).toBe(3)

    const cleared = new Promise<TurnStats | undefined>(resolve => {
      harness.ctx.on('chat/event', (event) => {
        if (event.type === 'session-stats' && event.stats === undefined) resolve(undefined)
      })
    })
    harness.ctx.chat.send(session.id, 'two')
    await expect(cleared).resolves.toBeUndefined()
  })
})
