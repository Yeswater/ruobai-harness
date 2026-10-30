import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ContractService from '@ruobai/contract'
import DeliveryService from '@ruobai/delivery'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import UiApi from '@ruobai/ui-server'
import WebServer from '@ruobai/web-server'
import DeliveryWeb from '../src/index.ts'

const acceptance = [
  {
    id: 'A1',
    criterion: '首页首屏在 2 秒内渲染完成',
    kind: 'auto' as const,
    check: { tool: 'bash' as const, command: 'curl -s localhost:3000', expectExit: 0 },
  },
  { id: 'A2', criterion: '客户能按 runbook 独立重启服务', kind: 'manual' as const },
]

async function mount() {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const web = ctx.plugin(WebServer, { port: 0, host: '127.0.0.1' })
  await web
  const ui = ctx.plugin(UiApi)
  await ui
  const contract = ctx.plugin(ContractService)
  await contract
  const delivery = ctx.plugin(DeliveryService)
  await delivery
  const adapter = ctx.plugin(DeliveryWeb)
  await adapter
  const meta = ctx.sessions.create({ title: '交付' })
  return {
    ctx,
    meta,
    async dispose() {
      await adapter.dispose()
      await delivery.dispose()
      await contract.dispose()
      await ui.dispose()
      await web.dispose()
      await tools.dispose()
      await sessions.dispose()
    },
  }
}

describe('delivery web', () => {
  it('reports an empty contract as unsure, never as a pass', async () => {
    const { ctx, meta, dispose } = await mount()
    const response = await fetch(`${ctx.web.url}/api/delivery?sessionId=${meta.id}`)
    expect(response.status).toBe(200)

    const body = await response.json() as any
    expect(body.contract).toBeNull()
    expect(body.verdict).toBe('unsure')
    expect(body.blocked).toBe(false)

    await dispose()
  })

  it('exposes acceptance rows with their live status', async () => {
    const { ctx, meta, dispose } = await mount()
    await ctx.tools.invoke('contract_open', {
      title: '交付 V1', customer: '客户 A', goals: ['上线'], nonGoals: ['不做多租户'], acceptance,
    }, { sessionId: meta.id })

    const body = await (await fetch(`${ctx.web.url}/api/delivery?sessionId=${meta.id}`)).json() as any
    expect(body.contract.title).toBe('交付 V1')
    expect(body.contract.acceptance.map((item: any) => item.id)).toEqual(['A1', 'A2'])
    expect(body.verdict).toBe('fail')
    expect(body.blocked).toBe(true)
    expect(body.checks.map((check: any) => check.status)).toEqual(['missing', 'manual-pending'])

    const ok = ctx.sessions.append(meta.id, 'tool/result', { callId: 'c1', name: 'bash', content: 'ok', isError: false })
    await ctx.tools.invoke('delivery_claim', {
      items: [{
        acceptanceId: 'A1',
        claim: 'curl returned 200',
        evidence: [{ kind: 'tool', ref: String(ok.seq), seq: ok.seq, summary: 'bash exit 0' }],
      }],
    }, { sessionId: meta.id })
    await ctx.tools.invoke('delivery_waive', { acceptanceId: 'A2', reason: '客户口头确认' }, { sessionId: meta.id })

    const passed = await (await fetch(`${ctx.web.url}/api/delivery?sessionId=${meta.id}`)).json() as any
    expect(passed.verdict).toBe('pass')
    expect(passed.blocked).toBe(false)
    expect(passed.waivers).toEqual(['A2'])
  })

  it('validates the request and rejects writes', async () => {
    const { ctx, meta, dispose } = await mount()
    expect((await fetch(`${ctx.web.url}/api/delivery`)).status).toBe(400)
    expect((await fetch(`${ctx.web.url}/api/delivery?sessionId=nope`)).status).toBe(404)
    expect((await fetch(`${ctx.web.url}/api/delivery?sessionId=${meta.id}`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${ctx.web.url}/api/delivery/other?sessionId=${meta.id}`)).status).toBe(404)
    await dispose()
  })
})
