import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '@ruobai/llm'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('interrupted steps', () => {
  it('marks a stopped step as interrupted and keeps it out of later requests', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    const requests: Message[][] = []
    let calls = 0
    harness.ctx.effect(() => harness.ctx.llm.register({
      name: 'scripted',
      async *stream(request) {
        calls += 1
        requests.push(request.messages)
        if (calls === 1) {
          for (let index = 0; index < 40; index += 1) {
            if (request.signal?.aborted) {
              yield { type: 'done' as const, reason: 'aborted' as const }
              return
            }
            yield { type: 'text-delta' as const, text: `片段${index}` }
            await sleep(15)
          }
          yield { type: 'done' as const, reason: 'stop' as const }
          return
        }
        yield { type: 'text-delta' as const, text: '完整回答' }
        yield { type: 'done' as const, reason: 'stop' as const }
      },
    }))
    await harness.ctx.settings.update({ llm: { activeProvider: 'scripted', activeModel: 'scripted-1' } })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const firstEnd = new Promise<void>(resolve => harness.ctx.once('agent/turn-end', () => resolve()))

    // Stop only after the step has produced something: the fragment is what
    // used to be persisted and replayed as a complete answer.
    const firstDelta = new Promise<void>(resolve => harness.ctx.once('agent/delta', () => resolve()))
    harness.ctx.chat.send(session.id, '写一段长的')
    await firstDelta
    await sleep(30)
    harness.ctx.chat.stop(session.id)
    await firstEnd

    const assistant = harness.ctx.sessions.get(session.id)?.events
      .filter(event => event.type === 'message/assistant').at(-1)
    expect(assistant?.data.interrupted).toBe(true)
    expect(assistant?.data.parts.some((part: { type: string; text?: string }) =>
      part.type === 'text' && part.text?.includes('片段'))).toBe(true)

    const live = harness.ctx.chat.get(session.id)?.messages
      .filter(message => message.role === 'assistant').at(-1)
    expect(live?.status).toBe('interrupted')

    const secondEnd = new Promise<void>(resolve => harness.ctx.once('agent/turn-end', () => resolve()))
    harness.ctx.chat.send(session.id, '继续')
    await secondEnd

    // The model must not see the fragment as an assistant turn it produced.
    const second = requests[1]!
    const assistantTexts = second
      .filter(message => message.role === 'assistant')
      .flatMap(message => message.content)
      .filter(part => part.type === 'text')
      .map(part => part.type === 'text' ? part.text : '')
    expect(assistantTexts.some(text => text.includes('片段'))).toBe(false)
    expect(second.some(message => message.role === 'user'
      && message.content.some(part => part.type === 'text' && part.text === '继续'))).toBe(true)
  })
})
