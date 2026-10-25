import { describe, expect, it } from 'vitest'
import { createHarness } from '../../../tests/harness.ts'

describe('trajectory web', () => {
  it('serves a paged snapshot folded by projections', async () => {
    const harness = await createHarness()
    try {
      const { ctx } = harness
      const session = ctx.chat.create(undefined, 'agent')
      ctx.sessions.append(session.id, 'message/user', { id: 'u1', text: 'first', at: 1 })
      ctx.sessions.append(session.id, 'message/assistant', {
        id: 'a1',
        at: 2,
        parts: [
          { type: 'text', text: 'working' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
        usage: { inputTokens: 10, outputTokens: 2 },
        timing: { stepStartTime: 2, firstTokenTime: 3, completedTime: 4 },
      })
      ctx.sessions.append(session.id, 'tool/result', { callId: 'c1', name: 'bash', content: 'ok', isError: false })
      ctx.sessions.append(session.id, 'message/user', { id: 'u2', text: 'second', at: 5 })
      ctx.sessions.append(session.id, 'message/assistant', {
        id: 'a2', at: 6, parts: [{ type: 'text', text: 'done' }],
      })

      const response = await fetch(`${ctx.web.url}/api/trajectory/sessions/${session.id}`)
      expect(response.status).toBe(200)
      const body = await response.json() as { snapshot: any }
      expect(body.snapshot.turns.map((turn: any) => turn.index)).toEqual([1, 2])
      expect(body.snapshot.records.map((record: any) => record.kind)).toEqual([
        'user', 'assistant', 'tool', 'user', 'assistant',
      ])
      expect(body.snapshot.records.find((record: any) => record.kind === 'tool').isError).toBe(false)
      expect(body.snapshot.hasMore).toBe(false)

      const page = await fetch(`${ctx.web.url}/api/trajectory/sessions/${session.id}?tail=1`).then(item => item.json()) as { snapshot: any }
      expect(page.snapshot.turns.map((turn: any) => turn.index)).toEqual([2])
      expect(page.snapshot.records.every((record: any) => record.turn === 2)).toBe(true)
      expect(page.snapshot.hasMore).toBe(true)
      expect(page.snapshot.beforeTurn).toBe(2)

      const older = await fetch(`${ctx.web.url}/api/trajectory/sessions/${session.id}?before=2&tail=1`).then(item => item.json()) as { snapshot: any }
      expect(older.snapshot.turns.map((turn: any) => turn.index)).toEqual([1])
      expect(older.snapshot.hasMore).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('returns 404 for an unknown session', async () => {
    const harness = await createHarness()
    try {
      const response = await fetch(`${harness.ctx.web.url}/api/trajectory/sessions/missing`)
      expect(response.status).toBe(404)
    } finally {
      await harness.dispose()
    }
  })
})
