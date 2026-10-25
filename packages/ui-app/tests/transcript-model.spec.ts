import { describe, expect, it } from 'vitest'
import type { ChatBlock, ChatMessage } from '@ruobai/chat-protocol'
import { buildPlan, segmentsOf } from '../src/transcript-model.ts'

let counter = 0
function message(role: ChatMessage['role'], blocks: ChatBlock[]): ChatMessage {
  counter += 1
  return { id: `m${counter}`, role, blocks, status: 'done', createdAt: counter }
}

function call(name: string, id = `c${++counter}`): ChatBlock {
  return { type: 'tool', callId: id, name, input: '{}', output: 'ok' }
}

const text = (value: string): ChatBlock => ({ type: 'text', text: value })
const reasoning = (value: string): ChatBlock => ({ type: 'reasoning', text: value })

describe('transcript plan', () => {
  it('folds consecutive tool-only steps into a single run', () => {
    const plan = buildPlan([
      message('user', [text('do it')]),
      message('assistant', [call('read_file'), call('read_file')]),
      message('assistant', [call('bash')]),
      message('assistant', [text('done')]),
    ])
    expect(plan.map(item => item.kind)).toEqual(['message', 'run', 'message'])
    expect(plan[1]).toMatchObject({ kind: 'run' })
    expect(plan[1]?.kind === 'run' && plan[1].blocks).toHaveLength(3)
  })

  it('starts a new run when prose or thinking separates the calls', () => {
    const plan = buildPlan([
      message('assistant', [call('bash')]),
      message('assistant', [reasoning('想一下'), call('bash')]),
      message('assistant', [call('bash')]),
    ])
    expect(plan.map(item => item.kind)).toEqual(['run', 'message', 'run'])
  })

  it('leaves messages with attachments out of runs', () => {
    const plan = buildPlan([
      message('user', [text('look')]),
      message('assistant', [text('ok')]),
    ])
    expect(plan.every(item => item.kind === 'message')).toBe(true)
  })
})

describe('message segments', () => {
  it('keeps prose inline and folds only the calls', () => {
    const segments = segmentsOf(message('assistant', [
      reasoning('先看看'),
      text('我来读一下'),
      call('read_file', 'a'),
      call('bash', 'b'),
    ]))
    expect(segments.map(segment => segment.kind)).toEqual(['block', 'block', 'run'])
    expect(segments[2]?.kind === 'run' && segments[2].blocks.map(block => block.name))
      .toEqual(['read_file', 'bash'])
  })

  it('splits runs around a later paragraph', () => {
    const segments = segmentsOf(message('assistant', [
      call('bash', 'a'),
      text('中间结论'),
      call('bash', 'b'),
    ]))
    expect(segments.map(segment => segment.kind)).toEqual(['run', 'block', 'run'])
  })

  it('keeps keys stable and unique', () => {
    const segments = segmentsOf(message('assistant', [text('a'), call('bash'), text('b'), call('bash')]))
    const keys = segments.map(segment => segment.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
