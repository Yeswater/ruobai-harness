import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@ruobai/session'
import { recordsProjection, timingProjection, turnsProjection, usageProjection } from '../src/index.ts'

function event(seq: number, type: string, data: any = {}, ts = 1_000 + seq): SessionEvent {
  return { seq, ts, type, data }
}

const user = (seq: number, text = 'hello') => event(seq, 'message/user', { id: `u${seq}`, text, at: seq })
const skill = (seq: number) => event(seq, 'message/user', {
  id: `s${seq}`, text: 'skill body', at: seq, source: { kind: 'skill', name: 'figma' },
})
const assistant = (seq: number, parts: any[], extra: any = {}) =>
  event(seq, 'message/assistant', { id: `a${seq}`, parts, at: seq, ...extra })
const toolResult = (seq: number, callId: string) =>
  event(seq, 'tool/result', { callId, name: 'bash', content: 'ok', isError: false })

describe('trajectory projections', () => {
  it('opens a turn per real user message and keeps skill injections inside it', () => {
    let state = turnsProjection.init()
    for (const item of [user(1, 'first'), skill(2), assistant(3, [{ type: 'text', text: 'ok' }]), user(4, 'second')]) {
      state = turnsProjection.apply(state, item)
    }
    expect(state.turns.map(turn => turn.index)).toEqual([1, 2])
    expect(state.turns[0]?.status).toBe('done')
    expect(state.turns[1]?.status).toBe('running')
    expect(state.turns[0]?.recordCount).toBe(3) // user + skill + assistant
  })

  it('folds a tool call and its result into one record', () => {
    let state = recordsProjection.init()
    state = recordsProjection.apply(state, user(1))
    state = recordsProjection.apply(state, assistant(2, [
      { type: 'text', text: 'running' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    ]))
    state = recordsProjection.apply(state, toolResult(3, 'c1'))
    const tools = state.records.filter(record => record.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.isError).toBe(false)
    expect(tools[0]?.detail).toContain('结果')
    expect(tools[0]?.timing?.completedAt).toBe(1_003)
    expect(state.records.map(record => record.kind)).toEqual(['user', 'assistant', 'tool'])
  })

  it('records the context snapshot as a context row in the current turn', () => {
    let state = recordsProjection.init()
    state = recordsProjection.apply(state, user(1))
    state = recordsProjection.apply(state, event(2, 'context/snapshot', {
      mode: 'agent', messages: 4, tools: 2, estimatedTokens: 1200, systemChars: 600,
    }))
    const context = state.records.find(record => record.kind === 'context')
    expect(context?.preview).toContain('4 条消息')
    expect(context?.turn).toBe(1)
  })

  it('aggregates usage and assistant timing', () => {
    let usage = usageProjection.init()
    let timing = timingProjection.init()
    usage = usageProjection.apply(usage, user(1))
    const message = assistant(2, [{ type: 'text', text: 'hi' }], {
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 },
      timing: { stepStartTime: 1_000, firstTokenTime: 1_050, completedTime: 1_200 },
    })
    usage = usageProjection.apply(usage, message)
    timing = timingProjection.apply(timing, message)
    expect(usage.entries).toEqual([{ turn: 1, step: 1, input: 10, output: 4, cacheRead: 2 }])
    expect(timing.spans[0]).toMatchObject({ kind: 'assistant', startedAt: 1_000, firstTokenAt: 1_050, completedAt: 1_200 })
  })
})
