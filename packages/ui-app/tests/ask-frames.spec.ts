import { describe, expect, it } from 'vitest'
import { parseAskFrame } from '../src/api.ts'

const request = {
  id: 'r1',
  sessionId: 's1',
  question: '要用哪套部署？',
  options: ['复用本地', '重装'],
  allowFreeText: true,
  createdAt: 1,
  expiresAt: 2,
}

describe('ask frames on the live downlink', () => {
  // The reported bug: the card never appeared over the WebSocket while SSE
  // worked, because ask-web broadcasts through `ui.broadcast` and web-ws wraps
  // that payload under `data`.
  it('reads a request from the data wrapper web-ws uses', () => {
    expect(parseAskFrame({ type: 'ask', data: { kind: 'requested', request } }))
      .toEqual({ kind: 'requested', request })
  })

  it('reads a resolution from the same wrapper', () => {
    expect(parseAskFrame({
      type: 'ask',
      data: { kind: 'resolved', resolution: { id: 'r1', via: 'option', answer: '复用本地' } },
    })).toEqual({
      kind: 'resolved',
      resolution: { id: 'r1', via: 'option', answer: '复用本地' },
    })
  })

  it('still accepts the top-level shape approval uses', () => {
    expect(parseAskFrame({ type: 'ask', kind: 'requested', request }))
      .toEqual({ kind: 'requested', request })
  })

  it('ignores a frame with nothing to resolve', () => {
    expect(parseAskFrame({ type: 'ask', data: { kind: 'resolved' } })).toBeUndefined()
    expect(parseAskFrame({ type: 'ask' })).toBeUndefined()
    expect(parseAskFrame(null)).toBeUndefined()
  })
})
