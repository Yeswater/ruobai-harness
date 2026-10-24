import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@ruobai/chat-protocol'
import {
  DEFAULT_VIEW, filterSessions, FLAT_KEY, groupSessions, moveSession, type SidebarView,
} from '../src/sidebar-model.ts'

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

const view = (patch: Partial<SidebarView> = {}): SidebarView => ({ ...DEFAULT_VIEW, ...patch })

describe('sidebar model', () => {
  it('filters archived sessions', () => {
    const sessions = [
      session({ id: 'a', archived: false }),
      session({ id: 'b', archived: true }),
    ]
    expect(filterSessions(sessions, 'active', '').map(item => item.id)).toEqual(['a'])
    expect(filterSessions(sessions, 'archived', '').map(item => item.id)).toEqual(['b'])
    expect(filterSessions(sessions, 'all', '').map(item => item.id)).toEqual(['a', 'b'])
  })

  it('matches titles and workspace paths while searching', () => {
    const sessions = [
      session({ id: 'a', title: '修复登录', workspace: '/code/api' }),
      session({ id: 'b', title: '布局', workspace: '/code/web' }),
    ]
    expect(filterSessions(sessions, 'active', '登录').map(item => item.id)).toEqual(['a'])
    expect(filterSessions(sessions, 'active', 'WEB').map(item => item.id)).toEqual(['b'])
  })

  it('groups by workspace with the most recent workspace first', () => {
    const sessions = [
      session({ id: 'a1', workspace: '/code/api', updatedAt: 10 }),
      session({ id: 'w1', workspace: '/code/web', updatedAt: 30 }),
      session({ id: 'w2', workspace: '/code/web', updatedAt: 20 }),
      session({ id: 'loose', updatedAt: 40 }),
    ]
    const groups = groupSessions(sessions, view(), {})
    expect(groups.map(item => item.label)).toEqual(['web', 'api', '未分组'])
    expect(groups[0]!.sessions.map(item => item.id)).toEqual(['w1', 'w2'])
    expect(groups.at(-1)!.sessions.map(item => item.id)).toEqual(['loose'])
  })

  it('applies stored manual order and appends new sessions newest-first', () => {
    const sessions = [
      session({ id: 'a', workspace: '/code/api', updatedAt: 10 }),
      session({ id: 'b', workspace: '/code/api', updatedAt: 30 }),
      session({ id: 'c', workspace: '/code/api', updatedAt: 20 }),
    ]
    const groups = groupSessions(sessions, view({ orderBy: 'manual' }), { '/code/api': ['a', 'c'] })
    expect(groups[0]!.sessions.map(item => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('builds a folder tree from workspace paths', () => {
    const sessions = [
      session({ id: 'api', workspace: '/Users/me/code/api', updatedAt: 1 }),
      session({ id: 'web1', workspace: '/Users/me/code/web/app', updatedAt: 2 }),
      session({ id: 'web2', workspace: '/Users/me/code/web/app', updatedAt: 3 }),
    ]
    const groups = groupSessions(sessions, view({ groupBy: 'tree' }), {})
    expect(groups.map(item => [item.label, item.depth])).toEqual([
      ['api', 0],
      ['web', 0],
      ['app', 1],
    ])
    expect(groups[0]!.path).toBe('/Users/me/code/api')
    expect(groups[1]!.sessions).toEqual([])
    expect(groups[2]!.sessions.map(item => item.id)).toEqual(['web2', 'web1'])
    expect(groups[2]!.canCreate).toBe(true)
  })

  it('returns one flat group for the single-list mode', () => {
    const sessions = [
      session({ id: 'a', updatedAt: 1 }),
      session({ id: 'b', updatedAt: 5 }),
    ]
    const groups = groupSessions(sessions, view({ groupBy: 'flat' }), {})
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe(FLAT_KEY)
    expect(groups[0]!.sessions.map(item => item.id)).toEqual(['b', 'a'])
  })

  it('moves a dragged session around its target', () => {
    expect(moveSession(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(moveSession(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
    expect(moveSession(['a', 'b'], 'a', 'a', 'before')).toEqual(['a', 'b'])
  })
})
