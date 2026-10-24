import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@ruobai/chat-protocol'
import {
  buildPaletteGroups, flattenEntries, matchCommands, matchSessions, type PaletteCommand,
} from '../src/command-palette-model.ts'

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: overrides.id,
    model: 'mock',
    updatedAt: 0,
    messageCount: 0,
    streaming: false,
    ...overrides,
  }
}

describe('command palette model', () => {
  it('lists the most recent sessions when the query is empty', () => {
    const sessions = [
      session({ id: 'old', updatedAt: 1 }),
      session({ id: 'fresh', updatedAt: 9 }),
      session({ id: 'hidden', updatedAt: 8, archived: true }),
    ]
    expect(matchSessions(sessions, '').map(item => item.id)).toEqual(['fresh', 'old'])
    expect(matchSessions(sessions, '', 1).map(item => item.id)).toEqual(['fresh'])
  })

  it('matches titles, workspace paths and models, ignoring case', () => {
    const sessions = [
      session({ id: 'a', title: '修复登录', workspace: '/code/api' }),
      session({ id: 'b', title: '布局重构', workspace: '/code/web' }),
      session({ id: 'c', title: '笔记', model: 'deepseek-chat' }),
    ]
    expect(matchSessions(sessions, '登录').map(item => item.id)).toEqual(['a'])
    expect(matchSessions(sessions, 'WEB').map(item => item.id)).toEqual(['b'])
    expect(matchSessions(sessions, 'deepseek').map(item => item.id)).toEqual(['c'])
  })

  it('ranks prefix hits above substring hits', () => {
    const sessions = [
      session({ id: 'sub', title: '今天修了登录', updatedAt: 99 }),
      session({ id: 'prefix', title: '登录修复', updatedAt: 1 }),
    ]
    expect(matchSessions(sessions, '登录').map(item => item.id)).toEqual(['prefix', 'sub'])
  })

  it('requires every term to match', () => {
    const sessions = [
      session({ id: 'a', title: '登录修复', workspace: '/code/api' }),
      session({ id: 'b', title: '登录修复', workspace: '/code/web' }),
    ]
    expect(matchSessions(sessions, '登录 api').map(item => item.id)).toEqual(['a'])
    expect(matchSessions(sessions, '登录 nope')).toEqual([])
  })

  it('matches commands through keywords and can be limited', () => {
    const commands: PaletteCommand[] = [
      { id: 'a', label: '打开设置', description: '通用', keywords: 'settings' },
      { id: 'b', label: 'MCP 连接器', description: '管理服务器', keywords: 'tool' },
    ]
    expect(matchCommands(commands, 'settings').map(item => item.id)).toEqual(['a'])
    expect(matchCommands(commands, 'tool').map(item => item.id)).toEqual(['b'])
    expect(matchCommands(commands, '服务器').map(item => item.id)).toEqual(['b'])
    expect(matchCommands(commands, '')).toHaveLength(2)
    expect(matchCommands(commands, '', 1)).toHaveLength(1)
  })

  it('groups sessions before commands and formats session meta', () => {
    const groups = buildPaletteGroups({
      sessions: [session({ id: 'a', title: '登录修复', workspace: '/code/api', updatedAt: 10 })],
      commands: [{ id: 'new-session', label: '新建会话', description: '打开工作区', shortcut: 'N' }],
      formatTime: () => '刚刚',
    })
    expect(groups.map(group => group.key)).toEqual(['sessions', 'commands'])
    expect(groups[0]!.entries[0]).toMatchObject({
      id: 'session:a',
      label: '登录修复',
      description: '/code/api',
      meta: '刚刚',
      sessionId: 'a',
    })
    expect(groups[1]!.entries[0]).toMatchObject({ commandId: 'new-session', shortcut: 'N' })
    expect(flattenEntries(groups).map(entry => entry.id)).toEqual(['session:a', 'command:new-session'])
  })

  it('drops groups that have no hits', () => {
    const groups = buildPaletteGroups({ sessions: [], commands: [] })
    expect(groups).toEqual([])
  })
})
