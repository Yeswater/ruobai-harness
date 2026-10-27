import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function useScripted(harness: Harness, provider: Parameters<Harness['ctx']['llm']['register']>[0]) {
  harness.ctx.effect(() => harness.ctx.llm.register(provider))
  await harness.ctx.settings.update({ llm: { activeProvider: 'scripted', activeModel: 'scripted-1' } })
}

describe('tool batches', () => {
  it('runs independent read-only calls from one step concurrently', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    let active = 0
    let peak = 0
    const probes: string[] = []
    for (const name of ['probe_a', 'probe_b']) {
      harness.ctx.effect(() => harness.ctx.tools.register({
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        readOnly: true,
        async execute() {
          probes.push(`${name}:start`)
          active += 1
          peak = Math.max(peak, active)
          await sleep(80)
          active -= 1
          probes.push(`${name}:end`)
          return name
        },
      }))
    }

    let step = 0
    await useScripted(harness, {
      name: 'scripted',
      async *stream() {
        step += 1
        if (step === 1) {
          yield { type: 'tool-call' as const, id: 'call_a', name: 'probe_a', arguments: '{}' }
          yield { type: 'tool-call' as const, id: 'call_b', name: 'probe_b', arguments: '{}' }
          yield { type: 'done' as const, reason: 'tool-calls' as const }
          return
        }
        yield { type: 'text-delta' as const, text: 'done' }
        yield { type: 'done' as const, reason: 'stop' as const }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const ended = new Promise<void>((resolve) => {
      harness.ctx.on('agent/turn-end', (id) => {
        if (id === session.id) resolve()
      })
    })
    harness.ctx.chat.send(session.id, 'go')
    await ended

    expect(peak).toBe(2)
    expect(probes.slice(0, 2).sort()).toEqual(['probe_a:start', 'probe_b:start'])

    // Results are persisted in call order even though both ran together.
    const results = harness.ctx.sessions.get(session.id)!.events
      .filter(event => event.type === 'tool/result')
      .map(event => event.data.name)
    expect(results).toEqual(['probe_a', 'probe_b'])
  })
})
