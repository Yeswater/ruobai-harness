import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('memory web', () => {
  it('creates, lists, pins, searches and forgets memory', async () => {
    harness = await createHarness()
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    const base = `${harness.ctx.web.url}/api/memory?sessionId=${session.id}`
    const json = { 'content-type': 'application/json' }

    const created = await fetch(base, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ text: '用户偏好中文回复', kind: 'preference' }),
    })
    expect(created.status).toBe(201)
    const { id } = await created.json() as { id: string }

    const listed = await (await fetch(base)).json() as {
      items: Array<{ id: string; text: string; pinned: boolean }>
      stats: { items: number }
    }
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.text).toBe('用户偏好中文回复')
    expect(listed.stats.items).toBe(1)

    const pinned = await (await fetch(`${harness.ctx.web.url}/api/memory/${id}/pin?sessionId=${session.id}`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ pinned: true }),
    })).json() as { item: { pinned: boolean } }
    expect(pinned.item.pinned).toBe(true)

    const searched = await (await fetch(`${harness.ctx.web.url}/api/memory/search?q=${encodeURIComponent('中文')}&sessionId=${session.id}`)).json() as {
      items: Array<{ id: string }>
    }
    expect(searched.items.map(item => item.id)).toEqual([id])

    const removed = await (await fetch(`${harness.ctx.web.url}/api/memory/${id}?sessionId=${session.id}`, {
      method: 'DELETE',
    })).json() as { forgotten: string[] }
    expect(removed.forgotten).toEqual([id])
  })

  it('rejects writes for an unknown session', async () => {
    harness = await createHarness()
    const response = await fetch(`${harness.ctx.web.url}/api/memory?sessionId=missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    expect(response.status).toBe(404)
  })
})
