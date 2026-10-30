import { beforeEach, describe, expect, it } from 'vitest'
import {
  DRAFT_TITLE, draftSession, draftSummary, isDraftId, resetDraftSeq, withDraftRow,
} from '../src/draft-session.ts'
import { DEFAULT_VIEW, groupSessions, UNGROUPED_KEY } from '../src/sidebar-model.ts'
import type { SessionSummary } from '@ruobai/chat-protocol'

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: overrides.id,
    model: 'mock',
    updatedAt: 0,
    messageCount: 3,
    streaming: false,
    ...overrides,
  }
}

/**
 * A new session is only a browser-side draft until its first message, but the
 * folder it was opened in has to show up in the sidebar right away — the bug
 * was that the sidebar stayed empty until the log existed.
 */
describe('draft session row', () => {
  beforeEach(() => resetDraftSeq())

  it('opens in the chosen folder with a placeholder title', () => {
    const draft = draftSession('/code/web')
    expect(isDraftId(draft.id)).toBe(true)
    expect(draft.workspace).toBe('/code/web')
    expect(draft.title).toBe(DRAFT_TITLE)
    expect(draft.messages).toEqual([])
  })

  it('hands the sidebar a row that belongs to the draft folder', () => {
    const draft = draftSession('/code/web')
    const row = draftSummary(draft)
    expect(row).toMatchObject({
      id: draft.id,
      title: DRAFT_TITLE,
      workspace: '/code/web',
      messageCount: 0,
      streaming: false,
      archived: false,
    })
  })

  it('lists the draft row on top without duplicating it', () => {
    const draft = draftSession('/code/web')
    const rows = withDraftRow([session({ id: 'a', workspace: '/code/web' })], draft)
    expect(rows.map(item => item.id)).toEqual([draft.id, 'a'])
    // A second call must not stack the same row twice.
    expect(withDraftRow(rows, draft).map(item => item.id)).toEqual([draft.id, 'a'])
  })

  it('adds no row when nothing is on screen', () => {
    expect(withDraftRow([session({ id: 'a' })], null).map(item => item.id)).toEqual(['a'])
  })

  it('groups the draft row under its workspace, not "未分组"', () => {
    const draft = draftSession('/code/web')
    const rows = withDraftRow([session({ id: 'a', workspace: '/code/api', updatedAt: 10 })], draft)
    const groups = groupSessions(rows, { ...DEFAULT_VIEW, groupBy: 'workspace' })
    const web = groups.find(group => group.key === '/code/web')
    expect(web?.sessions.map(item => item.id)).toEqual([draft.id])
    expect(groups.some(group => group.key === UNGROUPED_KEY)).toBe(false)
  })

  it('falls back to "未分组" only when no folder was picked', () => {
    const rows = withDraftRow([], draftSession())
    const groups = groupSessions(rows, { ...DEFAULT_VIEW, groupBy: 'workspace' })
    expect(groups.map(group => group.key)).toEqual([UNGROUPED_KEY])
    expect(groups[0]?.sessions).toHaveLength(1)
  })

  it('keeps the draft row in tree mode under the same folder', () => {
    const draft = draftSession('/code/web')
    const groups = groupSessions(withDraftRow([], draft), { ...DEFAULT_VIEW, groupBy: 'tree' })
    expect(groups.map(group => group.path)).toEqual(['/code/web'])
    expect(groups[0]?.sessions.map(item => item.id)).toEqual([draft.id])
  })
})
