import { describe, expect, it } from 'vitest'
import type { ChatBlock, ChatMessage } from '@ruobai/chat-protocol'
import {
  buildPlan, formatDuration, groupDuration, groupSummary, isGroupRunning, shouldGroupRun,
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

  it('keeps one group while a step has produced nothing yet', () => {
    // The reported flicker: a step/start used to add a separate 「思考中…」 row
    // next to the finished group, so the transcript jumped between two layouts
    // on every tool round trip.
    const plan = buildPlan([
      message('assistant', [thought('想'), call('bash')]),
      message('assistant', [], 'streaming'),
    ])
    expect(plan.map(item => item.kind)).toEqual(['process'])
    const group = plan[0]
    expect(group?.kind === 'process' && group.items).toHaveLength(2)
    expect(group?.kind === 'process' && Boolean(group.placeholder)).toBe(false)
  })

  it('marks a group with no rows as a placeholder', () => {
    const plan = buildPlan([message('assistant', [], 'streaming')])
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ kind: 'process', placeholder: true })
    expect(plan[0]?.kind === 'process' && plan[0].items).toEqual([])
  })

  it('starts a placeholder after prose instead of reusing the closed group', () => {
    const plan = buildPlan([
      message('assistant', [call('bash'), text('中间结论')]),
      message('assistant', [], 'streaming'),
    ])
    expect(plan.map(item => item.kind)).toEqual(['process', 'text', 'process'])
    expect(plan[2]).toMatchObject({ kind: 'process', placeholder: true })
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

  it('falls back to the start when an interrupted action never finished', () => {
    // A stopped turn leaves actions without a finish stamp; treating that as
    // "no duration" dropped the whole group's 用时.
    expect(groupDuration([
      { kind: 'tool', key: 'a', block: call('bash', { startedAt: 5_000, finishedAt: undefined }) as never },
    ])).toBe(0)
    expect(groupDuration([
      { kind: 'tool', key: 'a', block: call('bash', { finishedAt: undefined }) as never },
      { kind: 'tool', key: 'b', block: call('bash', { startedAt: 6_000, finishedAt: 9_000 }) as never },
    ])).toBe(8_000)
  })

  it('has no duration without any timestamp', () => {
    expect(groupDuration([
      { kind: 'tool', key: 'a', block: call('bash', { startedAt: undefined, finishedAt: undefined }) as never },
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

  it('drops a sub-second span instead of printing 用时 0 秒', () => {
    expect(groupSummary([
      { kind: 'tool', key: 'a', block: call('bash', { startedAt: 1_000, finishedAt: 1_200 }) as never },
    ])).toBe('已完成')
    expect(groupSummary([
      { kind: 'tool', key: 'a', block: call('bash', { startedAt: 1_000, finishedAt: 1_600 }) as never },
    ])).toBe('已完成，用时 1 秒')
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

describe('process group open state', () => {
  it('keeps the newest group open while the turn streams, even between steps', () => {
    expect(shouldGroupRun({ streaming: true, active: true, running: false })).toBe(true)
  })

  it('still opens older groups that have a pending row', () => {
    expect(shouldGroupRun({ streaming: true, active: false, running: true })).toBe(true)
    expect(shouldGroupRun({ streaming: true, active: false, placeholder: true, running: false })).toBe(true)
  })

  it('folds groups left behind by a finished turn', () => {
    expect(shouldGroupRun({ streaming: false, active: true, running: false })).toBe(false)
    expect(shouldGroupRun({ streaming: true, active: false, running: false })).toBe(false)
  })
})
