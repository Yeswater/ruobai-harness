import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ContractService from '@ruobai/contract'
import DeliveryService from '@ruobai/delivery'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import WebServer from '@ruobai/web-server'
import ClientAudit from '../src/index.ts'

async function mount(options: { enabled?: boolean } = {}) {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const web = ctx.plugin(WebServer, { port: 0, host: '127.0.0.1' })
  await web
  const contract = ctx.plugin(ContractService)
  await contract
  const delivery = ctx.plugin(DeliveryService)
  await delivery
  const audit = ctx.plugin(ClientAudit, { enabled: options.enabled ?? true })
  await audit
  const meta = ctx.sessions.create({ title: '审计' })
  return {
    ctx,
    meta,
    async dispose() {
      await audit.dispose()
      await delivery.dispose()
      await contract.dispose()
      await web.dispose()
      await tools.dispose()
      await sessions.dispose()
    },
  }
}

describe('client audit view', () => {
  it('registers no route unless it is explicitly enabled', async () => {
    const { ctx, meta, dispose } = await mount({ enabled: false })
    const response = await fetch(`${ctx.web.url}/api/audit/${meta.id}/summary`)
    expect(response.status).toBe(404)
    await dispose()
  })

  it('serves a summary with the recomputed verdict', async () => {
    const { ctx, meta, dispose } = await mount()
    await ctx.tools.invoke('contract_open', {
      title: '交付 V1',
      goals: ['上线'],
      nonGoals: [],
      acceptance: [{ id: 'A1', criterion: '首页 2s 内渲染', kind: 'auto', check: { tool: 'bash', command: 'curl', expectExit: 0 } }],
    }, { sessionId: meta.id })

    const response = await fetch(`${ctx.web.url}/api/audit/${meta.id}/summary`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.session.title).toBe('审计')
    expect(body.verdict.status).toBe('fail')
    expect(body.verdict.total).toBe(1)

    await dispose()
  })

  it('exposes only client-visible events, and only their summary', async () => {
    const { ctx, meta, dispose } = await mount()
    ctx.sessions.append(meta.id, 'message/user', { id: 'm1', text: '把首页改成 SSR', at: 1 })
    ctx.sessions.append(meta.id, 'tool/result', { callId: 'c1', name: 'bash', content: 'SECRET=/etc/passwd', isError: false })
    ctx.sessions.append(meta.id, 'settings/updated', { apiKey: 'sk-live' })

    const body = await (await fetch(`${ctx.web.url}/api/audit/${meta.id}/timeline`)).json() as any
    const types = body.entries.map((entry: any) => entry.type)
    expect(types).toContain('message/user')
    expect(types).not.toContain('tool/result')
    expect(types).not.toContain('settings/updated')
    expect(JSON.stringify(body)).not.toContain('SECRET')
    expect(JSON.stringify(body)).not.toContain('sk-live')

    await dispose()
  })

  it('rejects writes and unknown views', async () => {
    const { ctx, meta, dispose } = await mount()
    expect((await fetch(`${ctx.web.url}/api/audit/${meta.id}/summary`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${ctx.web.url}/api/audit/${meta.id}/whatever`)).status).toBe(404)
    expect((await fetch(`${ctx.web.url}/api/audit/nope/summary`)).status).toBe(404)
    await dispose()
  })
})
