import type { AttachmentMeta } from '@ruobai/chat-protocol'

export interface ComposerDraft {
  text: string
  attachments: AttachmentMeta[]
}

/**
 * Unsent composer state per session. Kept in memory so switching away and back
 * restores both the text and its images, without serializing image bytes.
 */
const drafts = new Map<string, ComposerDraft>()

function keyOf(sessionId: string | undefined) {
  return sessionId ?? ''
}

export function readDraft(sessionId: string | undefined): ComposerDraft {
  const draft = drafts.get(keyOf(sessionId))
  return draft
    ? { text: draft.text, attachments: [...draft.attachments] }
    : { text: '', attachments: [] }
}

export function writeDraft(sessionId: string | undefined, draft: ComposerDraft) {
  const key = keyOf(sessionId)
  if (!draft.text && !draft.attachments.length) {
    drafts.delete(key)
    return
  }
  drafts.set(key, { text: draft.text, attachments: [...draft.attachments] })
}

export function clearDraft(sessionId: string | undefined) {
  drafts.delete(keyOf(sessionId))
}
