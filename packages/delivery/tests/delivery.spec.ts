import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import ContractService from '@ruobai/contract'
import DeliveryService, { DELIVERY_PROJECTION, deliveryOf, evaluate } from '../src/index.ts'

const acceptance = [
  {
    id: 'A1',
    criterion: '首页首屏在 2 秒内渲染完成',
    kind: 'auto' as const,
    check: { tool: 'bash' as const, command: 'curl -s localhost:3000', expectExit: 0 },
  },
  { id: 'A2', criterion: '客户能按 runbook 独立重启服务', kind: 'manual' as const },
]

async function setup() {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const contract = ctx.plugin(ContractService)
  await contract
  const delivery = ctx.plugin(DeliveryService)
  await delivery
  const meta = ctx.sessions.create({ title: 'Delivery' })
  return {
    ctx,
    meta,
    async dispose() {
      await delivery.dispose()
      await contract.dispose()
      await tools.dispose()
      await sessions.dispose()
    },
  }
}

describe('delivery gate', () => {
  it('reports unsure when there is no contract', async () => {
    const { ctx, meta, dispose } = await setup()
    const verdict = evaluate(ctx, meta.id)
    expect(verdict.verdict).toBe('unsure')
    expect(verdict.reason).toBe('no-contract')
    await dispose()
  })

  it('fails while an acceptance item has no evidence', async () => {
    const { ctx, meta, dispose } = await setup()
    await ctx.tools.invoke('contract_open', { title: 'V1', goals: [], nonGoals: [], acceptance }, { sessionId: meta.id })

    const verdict = evaluate(ctx, meta.id)
    expect(verdict.verdict).toBe('fail')
    expect(verdict.checks.map(check => check.status)).toEqual(['missing', 'manual-pending'])

    await dispose()
  })

  it('passes only when every item has traceable evidence or a waiver', async () => {
    const { ctx, meta, dispose } = await setup()
    await ctx.tools.invoke('contract_open', { title: 'V1', goals: [], nonGoals: [], acceptance }, { sessionId: meta.id })

    // A successful tool call the evidence can point at.
    const ok = ctx.sessions.append(meta.id, 'tool/result', { callId: 'c1', name: 'bash', content: 'ok', isError: false })
    await ctx.tools.invoke('delivery_claim', {
      items: [{
        acceptanceId: 'A1',
        claim: 'curl returned 200',
        evidence: [{ kind: 'tool', ref: String(ok.seq), seq: ok.seq, summary: 'bash exit 0' }],
      }],
    }, { sessionId: meta.id })

    expect(evaluate(ctx, meta.id).verdict).toBe('fail')
    expect(evaluate(ctx, meta.id).checks[1]!.status).toBe('manual-pending')

    await ctx.tools.invoke('delivery_waive', { acceptanceId: 'A2', reason: '客户口头确认' }, { sessionId: meta.id })
    const verdict = evaluate(ctx, meta.id)
    expect(verdict.verdict).toBe('pass')
    expect(deliveryOf(ctx, meta.id).waivers).toEqual(['A2'])

    await dispose()
  })

  it('refuses evidence that points at a failed tool call', async () => {
    const { ctx, meta, dispose } = await setup()
    await ctx.tools.invoke('contract_open', { title: 'V1', goals: [], nonGoals: [], acceptance }, { sessionId: meta.id })

    const bad = ctx.sessions.append(meta.id, 'tool/result', { callId: 'c1', name: 'bash', content: 'boom', isError: true })
    await ctx.tools.invoke('delivery_claim', {
      items: [{
        acceptanceId: 'A1',
        claim: 'it failed but I claim it',
        evidence: [{ kind: 'tool', ref: String(bad.seq), seq: bad.seq, summary: 'bash failed' }],
      }],
    }, { sessionId: meta.id })

    const check = evaluate(ctx, meta.id).checks[0]!
    expect(check.status).toBe('failed')
    expect(check.reason).toContain(String(bad.seq))

    await dispose()
  })

  it('rejects a claim whose seq is not a tool result', async () => {
    const { ctx, meta, dispose } = await setup()
    await ctx.tools.invoke('contract_open', { title: 'V1', goals: [], nonGoals: [], acceptance }, { sessionId: meta.id })

    const result = await ctx.tools.invoke('delivery_claim', {
      items: [{
        acceptanceId: 'A1',
        claim: 'made up',
        evidence: [{ kind: 'tool', ref: '999', seq: 999, summary: 'nowhere' }],
      }],
    }, { sessionId: meta.id })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not a tool result')
    expect(deliveryOf(ctx, meta.id).claims).toHaveLength(0)

    await dispose()
  })

  it('refuses to waive an automatic acceptance item', async () => {
    const { ctx, meta, dispose } = await setup()
    await ctx.tools.invoke('contract_open', { title: 'V1', goals: [], nonGoals: [], acceptance }, { sessionId: meta.id })

    const result = await ctx.tools.invoke('delivery_waive', { acceptanceId: 'A1', reason: 'skip it' }, { sessionId: meta.id })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('needs evidence')

    await dispose()
  })

  it('drops the projection when the plugin is unmounted', async () => {
    const ctx = new Context()
    const sessions = ctx.plugin(SessionService)
    await sessions
    const tools = ctx.plugin(ToolRegistry)
    await tools
    const contract = ctx.plugin(ContractService)
    await contract
    const delivery = ctx.plugin(DeliveryService)
    await delivery
    const meta = ctx.sessions.create()

    expect(ctx.sessions.view(meta.id)?.[DELIVERY_PROJECTION]).toBeTruthy()
    await delivery.dispose()
    expect(ctx.sessions.view(meta.id)?.[DELIVERY_PROJECTION]).toBeUndefined()

    await contract.dispose()
    await tools.dispose()
    await sessions.dispose()
  })
})
