import { describe, expect, it } from 'vitest'
import type { TrajectoryEvent } from '../src/api.ts'
import {
  eventKind, eventLabel, eventPreview, eventText, isContextEvent, opensTurn,
} from '../src/components/trajectory-helpers.ts'

function event(type: string, data: Record<string, unknown> = {}, seq = 1): TrajectoryEvent {
  return { seq, ts: 0, type, data }
}

describe('trajectory records', () => {
  it('opens a turn only for real user input', () => {
    expect(opensTurn(event('message/user', { text: 'hi' }))).toBe(true)
    expect(opensTurn(event('message/user', {
      text: 'body',
      source: { kind: 'skill', name: 'figma' },
    }))).toBe(false)
  })

  it('renders a skill injection as a context record in the same turn', () => {
    const skill = event('message/user', { text: 'body', source: { kind: 'skill', name: 'figma' } })
    expect(eventKind(skill)).toBe('context')
    expect(eventLabel(skill)).toBe('技能')
    expect(isContextEvent(skill)).toBe(true)
    expect(eventPreview(skill)).toContain('figma')
  })

  it('summarises what the turn request was assembled from', () => {
    const snapshot = event('context/snapshot', {
      workspace: '/Users/x/work',
      mode: 'agent',
      provider: 'openai',
      model: 'deepseek-flash',
      permission: 'workspace-write',
      messages: 12,
      tools: 18,
      turns: 2,
      systemChars: 6200,
      estimatedTokens: 9400,
      summaryUpToSeq: 120,
      memoryUpToSeq: 200,
      focus: '继续实现',
    })
    expect(eventKind(snapshot)).toBe('context')
    expect(eventLabel(snapshot)).toBe('上下文')
    expect(isContextEvent(snapshot)).toBe(true)
    expect(eventPreview(snapshot)).toContain('12 条消息')
    expect(eventPreview(snapshot)).toContain('work')
    const detail = eventText(snapshot)
    expect(detail).toContain('系统提示 6,200 字符')
    expect(detail).toContain('第 2 轮')
    expect(detail).toContain('摘要覆盖至 #120')
    expect(detail).toContain('本轮输入：继续实现')
  })
})
