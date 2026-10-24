import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const fixture = fileURLToPath(new URL('../../mcp/tests/fixtures/server.mjs', import.meta.url))
const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

async function setup() {
  const harness = await createHarness()
  harnesses.push(harness)
  return harness
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 6_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error('condition was not met in time')
}

describe('mcp web api', () => {
  it('creates, connects, disables and deletes an MCP server', async () => {
    const { ctx } = await setup()
    const base = ctx.web.url
    const json = { 'Content-Type': 'application/json' }
    const getServers = async () =>
      (await (await fetch(`${base}/api/mcp`)).json() as { servers: any[] }).servers

    const created = await fetch(`${base}/api/mcp/servers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        label: 'Fixture',
        command: process.execPath,
        args: [fixture],
        env: { TOKEN: 'secret' },
        restart: false,
      }),
    })
    expect(created.status).toBe(201)
    const payload = await created.text()
    expect(payload).not.toContain('secret')
    expect(JSON.parse(payload).servers[0]).toMatchObject({
      id: 'fixture',
      label: 'Fixture',
      envKeys: ['TOKEN'],
      disabled: false,
    })

    await waitFor(async () => (await getServers())[0]?.status === 'connected')
    const connected = await getServers()
    expect(connected[0].tools).toEqual(expect.arrayContaining(['echo', 'add']))
    expect(ctx.tools.has('mcp__fixture__echo')).toBe(true)

    const disabled = await fetch(`${base}/api/mcp/servers/fixture`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ disabled: true }),
    })
    expect(disabled.status).toBe(200)
    await waitFor(async () => (await getServers())[0]?.status === 'disconnected')
    expect(ctx.tools.has('mcp__fixture__echo')).toBe(false)

    const reconnect = await fetch(`${base}/api/mcp/servers/fixture/reconnect`, { method: 'POST' })
    expect(reconnect.status).toBe(400)

    const removed = await fetch(`${base}/api/mcp/servers/fixture`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await removed.json()).servers).toEqual([])
    expect(ctx.mcp.get('fixture')).toBeUndefined()
  })

  it('reports a connection error without breaking the API', async () => {
    const { ctx } = await setup()
    const base = ctx.web.url
    const json = { 'Content-Type': 'application/json' }

    const created = await fetch(`${base}/api/mcp/servers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        label: 'Broken',
        command: 'definitely-not-a-real-command',
        restart: false,
      }),
    })
    expect(created.status).toBe(201)

    await waitFor(async () => {
      const body = await (await fetch(`${base}/api/mcp`)).json() as { servers: any[] }
      return body.servers[0]?.status === 'error'
    })

    const body = await (await fetch(`${base}/api/mcp`)).json() as { servers: any[] }
    expect(body.servers[0].error).toBeTruthy()
  })

  it('rejects invalid server input', async () => {
    const { ctx } = await setup()
    const response = await fetch(`${ctx.web.url}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'No command' }),
    })
    expect(response.status).toBe(400)
  })
})
