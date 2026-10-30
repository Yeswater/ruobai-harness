import type { ChatSession, SessionSummary } from '@ruobai/chat-protocol'

/**
 * A new session that lives only in this tab. The host learns about it on the
 * first message, so an untouched "new session" leaves neither a log nor a file
 * behind — but it still has a row in the sidebar, under the folder it was
 * opened in, so the folder shows up before the first message.
 */
export const DRAFT_PREFIX = 'draft:'

/** Placeholder title for an unsent session; the first message renames it. */
export const DRAFT_TITLE = '新会话'

let draftSeq = 0

export function isDraftId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DRAFT_PREFIX)
}

/** Reset the sequence; only tests need this so ids stay predictable. */
export function resetDraftSeq() {
  draftSeq = 0
}

export function draftSession(workspace?: string): ChatSession {
  const now = Date.now()
  return {
    id: `${DRAFT_PREFIX}${++draftSeq}`,
    title: DRAFT_TITLE,
    model: '',
    workspace,
    createdAt: now,
    updatedAt: now,
    messages: [],
    streaming: false,
  }
}

/**
 * The sidebar row for a draft. It is not a host session, so it never streams,
 * is never archived and holds no messages: only the folder it belongs to and
 * the fact that it is the row currently open matter.
 */
export function draftSummary(draft: ChatSession): SessionSummary {
  return {
    id: draft.id,
    title: DRAFT_TITLE,
    model: draft.model,
    ...(draft.provider ? { provider: draft.provider } : {}),
    ...(draft.mode ? { mode: draft.mode } : {}),
    ...(draft.permission ? { permission: draft.permission } : {}),
    ...(draft.workspace ? { workspace: draft.workspace } : {}),
    archived: false,
    updatedAt: draft.updatedAt,
    messageCount: 0,
    streaming: false,
  }
}

/**
 * Sidebar rows for the current screen: the draft (when nobody is typed into it
 * yet) sits on top of the persisted sessions, so its folder is already there.
 */
export function withDraftRow(
  sessions: readonly SessionSummary[],
  draft: ChatSession | null,
): SessionSummary[] {
  const rows = [...sessions]
  if (!draft || !isDraftId(draft.id)) return rows
  return [draftSummary(draft), ...rows.filter(item => !isDraftId(item.id))]
}
