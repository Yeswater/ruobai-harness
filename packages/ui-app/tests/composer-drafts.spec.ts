import { describe, expect, it } from 'vitest'
import type { AttachmentMeta } from '@ruobai/chat-protocol'
import { clearDraft, readDraft, writeDraft } from '../src/composer-drafts.ts'

function image(id: string): AttachmentMeta {
  return { id, kind: 'image', name: `${id}.png`, mime: 'image/png', size: 4, data: 'AAAA' }
}

describe('composer drafts', () => {
  it('keeps text and attachments separate per session', () => {
    writeDraft('a', { text: 'first', attachments: [image('a1')] })
    writeDraft('b', { text: 'second', attachments: [] })

    expect(readDraft('a').text).toBe('first')
    expect(readDraft('a').attachments.map(item => item.id)).toEqual(['a1'])
    expect(readDraft('b').text).toBe('second')
    expect(readDraft('b').attachments).toEqual([])
  })

  it('returns copies so callers cannot mutate the store', () => {
    writeDraft('copy', { text: 'draft', attachments: [image('img')] })
    const draft = readDraft('copy')
    draft.text = 'changed'
    draft.attachments.length = 0

    expect(readDraft('copy').text).toBe('draft')
    expect(readDraft('copy').attachments).toHaveLength(1)
  })

  it('forgets a draft once it is sent or cleared', () => {
    writeDraft('sent', { text: 'hello', attachments: [image('x')] })
    clearDraft('sent')
    expect(readDraft('sent')).toEqual({ text: '', attachments: [] })
  })

  it('does not keep an empty draft', () => {
    writeDraft('empty', { text: '', attachments: [] })
    expect(readDraft('empty')).toEqual({ text: '', attachments: [] })
    expect(() => clearDraft('empty')).not.toThrow()
  })

  it('keeps the no-session draft separate from real sessions', () => {
    writeDraft(undefined, { text: 'pre-session', attachments: [] })
    expect(readDraft(undefined).text).toBe('pre-session')
    expect(readDraft('session').text).toBe('')
    clearDraft(undefined)
  })
})
