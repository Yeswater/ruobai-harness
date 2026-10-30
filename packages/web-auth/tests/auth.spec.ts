import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'
import * as WebAuth from '../src/index.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

describe('web auth', () => {
  it('requires a bearer token, cookie, or ?token= and checks origins', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const auth = harness.ctx.plugin(WebAuth, { token: 'secret' })
    await auth
    const base = harness.ctx.web.url

    expect((await fetch(`${base}/api/sessions`)).status).toBe(401)

    const authorized = await fetch(`${base}/api/sessions`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(authorized.status).toBe(200)

    const login = await fetch(`${base}/?token=secret`, { redirect: 'manual' })
    expect(login.status).toBe(302)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect(await login.text()).toBe('')

    const viaCookie = await fetch(`${base}/api/sessions`, { headers: { cookie } })
    expect(viaCookie.status).toBe(200)

    const evil = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { Origin: 'http://evil.test', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(evil.status).toBe(403)

    await auth.dispose()
  })

  it('confines a read-only token to audit, handoff and export', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const auth = harness.ctx.plugin(WebAuth, { token: 'secret', auditTokens: ['reader'] })
    await auth
    const base = harness.ctx.web.url
    const session = harness.ctx.sessions.create({ title: 'audit' })

    // Allowed: the handoff bundle is exactly what a customer should read.
    const handoff = await fetch(`${base}/api/handoff/${session.id}/manifest`, {
      headers: { Authorization: 'Bearer reader' },
    })
    expect(handoff.status).toBe(200)

    // Refused: the console API is a full-scope surface.
    const sessions = await fetch(`${base}/api/sessions`, {
      headers: { Authorization: 'Bearer reader' },
    })
    expect(sessions.status).toBe(403)

    // Refused: a write, even to an allowlisted prefix.
    const write = await fetch(`${base}/api/handoff/${session.id}/manifest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer reader', Origin: base },
    })
    expect(write.status).toBe(403)

    // The full token keeps working.
    const full = await fetch(`${base}/api/sessions`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(full.status).toBe(200)

    await auth.dispose()
  })
})
