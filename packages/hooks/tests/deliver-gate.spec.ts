import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ContractService from '@ruobai/contract'
import DeliveryService from '@ruobai/delivery'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import HooksService from '../src/index.ts'

const acceptance = [
  {
    id: 'A1',
    criterion: '首页首屏在 2 秒内渲染完成',
    kind: 'auto' as const,
    check: { tool: 'bash' as const, command: 'curl -s localhost:3000', expectExit: 0 },
  },
  { id: 'A2', criterion: '客户能按 runbook 独立重启服务', kind: 'manual' as const },
]

async function mount(options: { delivery?: boolean } = {}) {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const contract = ctx.plugin(ContractService)
  await contract
  const delivery = options.delivery === false ? undefined : ctx.plugin(DeliveryService)
  if (delivery) await delivery
  const hooks = ctx.plugin(HooksService)
  await hooks
  const meta = ctx.sessions.create({ title: 'Gate' })
  return {
    ctx,
    meta,
    async dispose() {
      await hooks.dispose()
      if (delivery) await delivery.dispose()
      await contract.dispose()
      await tools.dispose()
      await sessions.dispose()
    },
  }
}

async function openContract(ctx: Context, sessionId: string) {
  await ctx.tools.invoke('contract_open', {
    title: '交付 V1',
    goals: ['上线'],
    nonGoals: [],
    acceptance,
  }, { sessionId })
}

describe('delivery gate wiring', () => {
  it('skips without a contract and records why', async () => {
    const { ctx, meta, dispose } = await mount()
    const decision = await ctx.hooks.beforeDeliver(meta.id)

    expect(decision.blocked).toBe(false)
    const skipped = ctx.sessions.get(meta.id)!.events.find(event => event.type === 'gate/skipped')
    expect(skipped?.data.reason).toBe('no-contract')

    await dispose()
  })

  it('blocks while acceptance items are uncovered', async () => {
    const { ctx, meta, dispose } = await mount()
    await openContract(ctx, meta.id)

    const decision = await ctx.hooks.beforeDeliver(meta.id)
    expect(decision.blocked).toBe(true)
    expect(decision.feedback).toContain('<delivery-gate')
    expect(decision.feedback).toContain('A1')
    expect(decision.feedback).toContain('A2')

    await dispose()
  })

  it('passes once evidence and a waiver cover every item', async () => {
    const { ctx, meta, dispose } = await mount()
    await openContract(ctx, meta.id)

    const ok = ctx.sessions.append(meta.id, 'tool/result', { callId: 'c1', name: 'bash', content: 'ok', isError: false })
    await ctx.tools.invoke('delivery_claim', {
      items: [{
        acceptanceId: 'A1',
        claim: 'curl returned 200',
        evidence: [{ kind: 'tool', ref: String(ok.seq), seq: ok.seq, summary: 'bash exit 0' }],
      }],
    }, { sessionId: meta.id })
    await ctx.tools.invoke('delivery_waive', { acceptanceId: 'A2', reason: '客户口头确认' }, { sessionId: meta.id })

    const decision = await ctx.hooks.beforeDeliver(meta.id)
    expect(decision.blocked).toBe(false)
    const verdict = ctx.sessions.get(meta.id)!.events.find(event => event.type === 'delivery/verdict')
    expect(verdict?.data.verdict).toBe('pass')

    await dispose()
  })

  it('escalates instead of looping when the same gap repeats', async () => {
    const { ctx, meta, dispose } = await mount()
    await openContract(ctx, meta.id)

    const first = await ctx.hooks.beforeDeliver(meta.id)
    const second = await ctx.hooks.beforeDeliver(meta.id)

    // Same gap twice: blocking again would loop, so the gate escalates instead.
    expect(first.blocked).toBe(true)
    expect(second.blocked).toBe(false)
    expect(second.escalated).toBe(true)
    const escalated = ctx.sessions.get(meta.id)!.events.find(event => event.type === 'hooks/escalated')
    expect(escalated).toBeTruthy()
    const verdict = ctx.sessions.get(meta.id)!.events.filter(event => event.type === 'delivery/verdict').at(-1)
    expect(verdict?.data.verdict).toBe('unsure')

    await dispose()
  })

  it('records a skip when the delivery plugin is not mounted', async () => {
    const { ctx, meta, dispose } = await mount({ delivery: false })
    await openContract(ctx, meta.id)

    const decision = await ctx.hooks.beforeDeliver(meta.id)
    expect(decision.blocked).toBe(false)
    const skipped = ctx.sessions.get(meta.id)!.events.find(event => event.type === 'gate/skipped')
    expect(skipped?.data.reason).toBe('delivery-not-mounted')

    await dispose()
  })
})
