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

  it('times decode windows and keeps tool round trips out of them', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    let step = 0
    await useScripted(harness, {
      name: 'scripted',
      async *stream() {
        step += 1
        yield* paced(3, 150, { type: 'text-delta' as const, text: 'checking' })
        if (step === 1) {
          yield {
            type: 'tool-call' as const,
            id: 'call_list',
            name: 'list_dir',
            arguments: JSON.stringify({ path: '.' }),
          }
          yield {
            type: 'done' as const,
            reason: 'tool-calls' as const,
            usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20 },
          }
        } else {
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
    // Disjoint billing, summed across both steps.
    expect(stats.inputTokens).toBe(300)
    expect(stats.outputTokens).toBe(100)
    expect(stats.cachedInputTokens).toBe(210)
    // Both steps measured a window, and both are paired with their tokens.
    expect(stats.streamedOutputTokens).toBe(100)
    expect(stats.generationMs).toBeGreaterThan(500)
    expect(stats.generationMs).toBeLessThan(2000)
    expect(stats.ttftMs).toBeDefined()
  })

  it('leaves a one-burst step out of the decode rate', async () => {
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
    // Billed tokens are still reported; only the unmeasurable window is dropped.
    expect(stats.outputTokens).toBe(400)
    expect(stats.streamedOutputTokens).toBeUndefined()
    expect(stats.generationMs).toBeUndefined()
  })

  it('records billing and timing on the log so the projection can rebuild them', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    await useScripted(harness, {
      name: 'scripted',
      async *stream() {
        yield* paced(2, 80, { type: 'text-delta' as const, text: 'ok' })
        yield { type: 'done', reason: 'stop', usage: { inputTokens: 12, outputTokens: 6, cachedInputTokens: 4 } }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const done = new Promise<void>((resolve) => {
      harness.ctx.once('agent/turn-end', () => resolve())
    })
    harness.ctx.chat.send(session.id, 'hi')
    await done

    const assistant = harness.ctx.sessions.get(session.id)?.events
      .find(event => event.type === 'message/assistant')
    expect(assistant?.data.usage).toMatchObject({ inputTokens: 12, outputTokens: 6, cachedInputTokens: 4 })
    expect(assistant?.data.timing).toMatchObject({ completedTime: expect.any(Number) })
    expect(assistant?.data.timing.firstTokenTime).toBeGreaterThanOrEqual(assistant?.data.timing.stepStartTime)

    // What a browser gets on the next load: the chat projection folds the log in
    // the same pass that renders the messages, so nothing has to be re-requested.
    const stats = harness.ctx.chat.get(session.id)?.stats
    expect(stats).toMatchObject({ inputTokens: 12, outputTokens: 6, cachedInputTokens: 4, steps: 1 })
    expect(stats?.generationMs).toBeGreaterThan(0)
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
