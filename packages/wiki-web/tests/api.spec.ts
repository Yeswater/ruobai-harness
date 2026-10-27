import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('wiki web', () => {
  it('creates, lists, edits, searches and archives pages', async () => {
    harness = await createHarness()
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    const base = `${harness.ctx.web.url}/api/wiki`
    const json = { 'content-type': 'application/json' }
    const suffix = `sessionId=${session.id}`

    const created = await fetch(`${base}/page?${suffix}`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        title: 'macOS Seatbelt 沙箱',
        body: '## 摘要\n\nSeatbelt 沙箱只接受 localhost。\n\n## 事实\n\n嵌套 sandbox-exec 会 exit 71。',
        tags: ['sandbox'],
      }),
    })
    expect(created.status).toBe(201)
    const { id, revision } = await created.json() as { id: string; revision: number }
    expect(id).toBe('macos-seatbelt')
    expect(revision).toBe(1)

    const listed = await (await fetch(`${base}?${suffix}`)).json() as {
      pages: Array<{ id: string; summary: string }>
      stats: { pages: number }
    }
    expect(listed.pages.map(page => page.id)).toEqual([id])
    expect(listed.stats.pages).toBe(1)

    const detail = await (await fetch(`${base}/page/${id}?${suffix}`)).json() as {
      meta: { revision: number }
      body: string
    }
    expect(detail.body).toContain('exit 71')

    const updated = await fetch(`${base}/page/${id}?${suffix}`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({
        title: 'macOS Seatbelt 沙箱',
        body: '## 摘要\n\n第二版。',
        tags: ['sandbox'],
      }),
    })
    expect(updated.status).toBe(200)
    expect((await updated.json() as { revision: number }).revision).toBe(2)

    const versions = await (await fetch(`${base}/page/${id}/versions?${suffix}`)).json() as { versions: number[] }
    expect(versions.versions).toEqual([1])

    const diff = await (await fetch(`${base}/page/${id}/diff?from=1&to=2&${suffix}`)).json() as { diff: string }
    expect(diff.diff).toContain('-嵌套 sandbox-exec 会 exit 71')
    expect(diff.diff).toContain('+第二版')
    expect(diff.diff).not.toContain('updated:')

    const found = await (await fetch(`${base}/search?q=${encodeURIComponent('沙箱')}&${suffix}`)).json() as {
      hits: Array<{ page: string }>
    }
    expect(found.hits[0]?.page).toBe(id)

    const archived = await fetch(`${base}/page/${id}?${suffix}`, { method: 'DELETE' })
    expect(archived.status).toBe(200)
    const afterwards = await (await fetch(`${base}?${suffix}`)).json() as { pages: unknown[] }
    expect(afterwards.pages).toEqual([])
  })

  it('creates and accepts a session proposal', async () => {
    harness = await createHarness()
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    harness.ctx.sessions.append(session.id, 'message/user', { text: '把沙箱网络限制写成页面' })
    harness.ctx.sessions.append(session.id, 'message/assistant', {
      parts: [{ type: 'text', text: '结论：只允许 localhost。' }],
    })
    const base = `${harness.ctx.web.url}/api/wiki`
    const suffix = `sessionId=${session.id}`

    const proposed = await fetch(`${base}/proposals?${suffix}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Sandbox network' }),
    })
    expect(proposed.status).toBe(201)
    const { id } = await proposed.json() as { id: string }

    const listed = await (await fetch(`${base}/proposals?${suffix}`)).json() as { proposals: Array<{ id: string }> }
    expect(listed.proposals.map(item => item.id)).toEqual([id])

    const review = await (await fetch(`${base}/proposals/${id}?${suffix}`)).json() as {
      existing: unknown
      diff: string
      body: string
    }
    expect(review.existing).toBeNull()
    expect(review.diff).toContain('+')

    const edited = await fetch(`${base}/proposals/${id}?${suffix}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Sandbox network', body: '## 摘要\n\n编辑后的提案。' }),
    })
    expect(edited.status).toBe(200)
    const reread = await (await fetch(`${base}/proposals/${id}?${suffix}`)).json() as { body: string }
    expect(reread.body).toContain('编辑后的提案')

    const accepted = await fetch(`${base}/proposals/${id}/accept?${suffix}`, { method: 'POST' })
    expect(accepted.status).toBe(200)
    const pages = await (await fetch(`${base}?${suffix}`)).json() as { pages: Array<{ id: string }>; proposals: unknown[] }
    expect(pages.pages.map(page => page.id)).toEqual([id])
    expect(pages.proposals).toEqual([])
  })

  it('reports lint findings', async () => {
    harness = await createHarness()
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    const suffix = `sessionId=${session.id}`
    await fetch(`${harness.ctx.web.url}/api/wiki/page?${suffix}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Lone page', body: '## 摘要\n\n[[missing]]' }),
    })
    const lint = await (await fetch(`${harness.ctx.web.url}/api/wiki/lint?${suffix}`)).json() as {
      findings: Array<{ kind: string }>
    }
    expect(lint.findings.some(finding => finding.kind === 'broken-link')).toBe(true)
  })
})
