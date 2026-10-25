import { describe, expect, it } from 'vitest'
import type { ChatBlock, ChatMessage } from '@ruobai/chat-protocol'
import {
  buildPlan, formatDuration, groupDuration, groupSummary, isGroupRunning,
} from '../src/transcript-model.ts'

let counter = 0
function message(role: ChatMessage['role'], blocks: ChatBlock[], status: ChatMessage['status'] = 'done'): ChatMessage {
  counter += 1
  return { id: `m${counter}`, role, blocks, status, createdAt: counter }
}

function call(name: string, extra: Partial<ChatBlock> = {}): ChatBlock {
  counter += 1
  return {
    type: 'tool',
    callId: `c${counter}`,
    name,
    input: '{}',
    output: 'ok',
    startedAt: 1_000,
    finishedAt: 3_000,
    ...extra,
  } as ChatBlock
}

const text = (value: string): ChatBlock => ({ type: 'text', text: value })
const thought = (value: string, bounds?: { startedAt?: number; finishedAt?: number }): ChatBlock =>
  ({ type: 'reasoning', text: value, ...bounds })

describe('transcript plan', () => {
  it('folds thoughts and calls into one process group between paragraphs', () => {
    const plan = buildPlan([
      message('user', [text('do it')]),
      message('assistant', [thought('先看看'), call('bash')]),
      message('assistant', [call('read_file'), text('done')]),
    ])
    expect(plan.map(item => item.kind)).toEqual(['user', 'process', 'text'])
    const group = plan[1]
    expect(group?.kind === 'process' && group.items.map(item => item.kind))
      .toEqual(['reasoning', 'tool', 'tool'])
  })

  it('always keeps prose visible, splitting the group around it', () => {
    const plan = buildPlan([
      message('assistant', [call('bash'), text('中间结论'), call('bash')]),
    ])
    expect(plan.map(item => item.kind)).toEqual(['process', 'text', 'process'])
  })

  it('marks the last paragraph of a streaming step', () => {
    const plan = buildPlan([message('assistant', [text('部分')], 'streaming')])
    expect(plan[0]).toMatchObject({ kind: 'text', streaming: true })
  })

  it('gives every plan item a unique key', () => {
    const plan = buildPlan([
      message('user', [text('a')]),
      message('assistant', [thought('t'), call('bash'), text('b')]),
      message('assistant', [call('bash')]),
    ])
    const keys = plan.map(item => item.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('process group state', () => {
  it('marks only unsettled rows as pending', () => {
    const plan = buildPlan([
      message(
        'assistant',
        [thought('先看看', { startedAt: 0 }), call('bash', { output: '', finishedAt: undefined })],
        'streaming',
      ),
    ])
    const group = plan[0]
    expect(group?.kind === 'process' && group.items.map(item => item.pending)).toEqual([true, true])
    expect(group && isGroupRunning(group.kind === 'process' ? group.items : [])).toBe(true)
  })

  it('never leaves a finished step pending, even without timestamps', () => {
    // The reported bug: a settled message whose log has no finishedAt used to
    // render every thought row as "思考中" forever.
    const plan = buildPlan([
      message('assistant', [thought('想完了'), call('bash', { finishedAt: undefined })]),
    ])
    const group = plan[0]
    expect(group?.kind === 'process' && group.items.map(item => item.pending)).toEqual([false, false])
    expect(group && isGroupRunning(group.kind === 'process' ? group.items : [])).toBe(false)
  })

  it('spans the earliest start to the latest end', () => {
    const items = [
      { kind: 'tool' as const, key: 'a', block: call('bash', { startedAt: 1_000, finishedAt: 2_000 }) as never },
      { kind: 'tool' as const, key: 'b', block: call('bash', { startedAt: 2_500, finishedAt: 5_500 }) as never },
    ]
    expect(groupDuration(items)).toBe(4_500)
  })

  it('has no duration until both bounds are recorded', () => {
    expect(groupDuration([
      { kind: 'tool', key: 'a', block: call('bash', { finishedAt: undefined }) as never },
    ])).toBeUndefined()
  })

  it('summarizes a finished group with its duration', () => {
    const items = [
      { kind: 'tool' as const, key: 'a', block: call('bash', { startedAt: 0, finishedAt: 90_000 }) as never },
    ]
    expect(groupSummary(items)).toBe('已完成，用时 1分30秒')
  })

  it('counts failures in the summary', () => {
    const items = [
      { kind: 'tool' as const, key: 'a', block: call('bash', { startedAt: 0, finishedAt: 2_000, isError: true }) as never },
    ]
    expect(groupSummary(items)).toBe('已完成，用时 2 秒（1 个失败）')
  })

  it('says 已完成 without a span', () => {
    expect(groupSummary([
      { kind: 'reasoning', key: 'a', block: thought('想') as never },
    ])).toBe('已完成')
  })
})

describe('duration format', () => {
  it('drops empty units', () => {
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(42_000)).toBe('42 秒')
    expect(formatDuration(90_000)).toBe('1分30秒')
    expect(formatDuration(120_000)).toBe('2分')
    expect(formatDuration(3_900_000)).toBe('1小时5分')
  })
})
