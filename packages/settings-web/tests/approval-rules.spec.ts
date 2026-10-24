import { afterEach, describe, expect, it } from 'vitest'
import { createHarness } from '../../../tests/harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json() as any }
}

const json = { 'Content-Type': 'application/json' }

describe('approval rules API', () => {
  it('creates, broadens, lists and deletes rules; matched calls skip approval', async () => {
    const harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url

    const empty = await call(`${base}/api/approval/rules`)
    expect(empty.status).toBe(200)
    expect(empty.body.rules).toEqual([])

    const created = await call(`${base}/api/approval/rules`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ tool: 'bash', match: 'exact', pattern: 'echo hi', action: 'allow' }),
    })
    expect(created.status).toBe(201)
    expect(created.body.rules).toHaveLength(1)
    expect(created.body.rules[0].action).toBe('allow')
    const id = created.body.rules[0].id

    const result = await harness.ctx.tools.invoke('bash', { command: 'echo hi' })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('hi')

    const broadened = await call(`${base}/api/approval/rules/${id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ match: 'prefix', pattern: 'echo' }),
    })
    expect(broadened.status).toBe(200)
    expect(broadened.body.rules[0]).toMatchObject({ match: 'prefix', pattern: 'echo' })

    const invalid = await call(`${base}/api/approval/rules`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ tool: 'bash', match: 'prefix', pattern: 'echo hi && rm -rf /' }),
    })
    expect(invalid.status).toBe(400)

    const invalidAction = await call(`${base}/api/approval/rules`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ tool: 'bash', match: 'exact', pattern: 'echo hi', action: 'sometimes' }),
    })
    expect(invalidAction.status).toBe(400)

    const missing = await call(`${base}/api/approval/rules/missing`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ pattern: 'x' }),
    })
    expect(missing.status).toBe(404)

    const deleted = await call(`${base}/api/approval/rules/${id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(deleted.body.rules).toEqual([])
  })

  it('reads and updates the danger guard', async () => {
    const harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const base = harness.ctx.web.url

    const initial = await call(`${base}/api/approval/guard`)
    expect(initial.status).toBe(200)
    expect(initial.body.guard).toEqual({ enabled: true })
    expect(initial.body.builtin.length).toBeGreaterThan(20)

    const updated = await call(`${base}/api/approval/guard`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ enabled: false }),
    })
    expect(updated.status).toBe(200)
    expect(updated.body.guard).toEqual({ enabled: false })

    const stored = harness.ctx.settings.approvalGuard()
    expect(stored).toEqual({ enabled: false })
  })
})
