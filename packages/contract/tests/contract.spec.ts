import { describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import ContractService, { CONTRACT_EVENT, CONTRACT_PROJECTION, contractOf } from '../src/index.ts'

const acceptance = [
  {
    id: 'A1',
    criterion: '首页首屏在 2 秒内渲染完成',
    kind: 'auto' as const,
    check: { tool: 'bash' as const, command: 'curl -s -o /dev/null -w %{time_total} localhost:3000', expectExit: 0 },
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
  const meta = ctx.sessions.create({ title: 'Contract' })
  return {
    ctx,
    meta,
    async dispose() {
      await contract.dispose()
      await tools.dispose()
      await sessions.dispose()
    },
  }
}

describe('task contract', () => {
  it('records a contract and exposes it through the projection', async () => {
    const { ctx, meta, dispose } = await setup()

    const result = await ctx.tools.invoke('contract_open', {
      title: '交付 V1',
      customer: '客户 A',
      goals: ['上线'],
      nonGoals: ['不做多租户'],
      acceptance,
    }, { sessionId: meta.id })

    expect(result.isError).toBe(false)
    const state = contractOf(ctx, meta.id)
    expect(state.open?.title).toBe('交付 V1')
    expect(state.open?.customer).toBe('客户 A')
    expect(state.open?.acceptance.map(item => item.id)).toEqual(['A1', 'A2'])
    expect(state.open?.revision).toBe(1)
    expect(ctx.sessions.get(meta.id)!.events.some(event => event.type === CONTRACT_EVENT)).toBe(true)

    await dispose()
  })

  it('refuses a second open contract and points at amend', async () => {
    const { ctx, meta, dispose } = await setup()
    const input = { title: '交付 V1', goals: ['上线'], nonGoals: [], acceptance }

    await ctx.tools.invoke('contract_open', input, { sessionId: meta.id })
    const second = await ctx.tools.invoke('contract_open', input, { sessionId: meta.id })

    expect(second.isError).toBe(true)
    expect(second.content).toContain('contract_amend')
    expect(contractOf(ctx, meta.id).open?.revision).toBe(1)

    await dispose()
  })

  it('rejects invalid acceptance without writing an event', async () => {
    const { ctx, meta, dispose } = await setup()
    const before = ctx.sessions.get(meta.id)!.events.length

    const badId = await ctx.tools.invoke('contract_open', {
      title: 'x', goals: [], nonGoals: [],
      acceptance: [{ id: 'one', criterion: 'c', kind: 'manual' }],
    }, { sessionId: meta.id })
    expect(badId.isError).toBe(true)

    const manualWithCommand = await ctx.tools.invoke('contract_open', {
      title: 'x', goals: [], nonGoals: [],
      acceptance: [{ id: 'A1', criterion: 'c', kind: 'manual', check: { tool: 'bash', command: 'echo' } }],
    }, { sessionId: meta.id })
    expect(manualWithCommand.isError).toBe(true)

    const tooMany = await ctx.tools.invoke('contract_open', {
      title: 'x', goals: [], nonGoals: [],
      acceptance: Array.from({ length: 21 }, (_, index) => ({ id: `A${index + 1}`, criterion: 'c', kind: 'manual' })),
    }, { sessionId: meta.id })
    expect(tooMany.isError).toBe(true)

    expect(ctx.sessions.get(meta.id)!.events.length).toBe(before)
    expect(contractOf(ctx, meta.id).open).toBeNull()

    await dispose()
  })

  it('amends goals and appends acceptance but never drops an id', async () => {
    const { ctx, meta, dispose } = await setup()
    await ctx.tools.invoke('contract_open', {
      title: '交付 V1', goals: ['上线'], nonGoals: [], acceptance,
    }, { sessionId: meta.id })

    const amended = await ctx.tools.invoke('contract_amend', {
      goals: ['上线', '可回滚'],
      acceptance: [...acceptance, { id: 'A3', criterion: '回滚在 5 分钟内完成', kind: 'manual' }],
      reason: '客户追加回滚要求',
    }, { sessionId: meta.id })

    expect(amended.isError).toBe(false)
    const state = contractOf(ctx, meta.id)
    expect(state.open?.goals).toEqual(['上线', '可回滚'])
    expect(state.open?.acceptance.map(item => item.id)).toEqual(['A1', 'A2', 'A3'])
    expect(state.open?.revision).toBe(2)

    const dropped = await ctx.tools.invoke('contract_amend', {
      acceptance: [acceptance[0]],
      reason: '试图删除',
    }, { sessionId: meta.id })
    expect(dropped.isError).toBe(true)
    expect(dropped.content).toContain('A2')

    await dispose()
  })

  it('closes the contract and allows a new one', async () => {
    const { ctx, meta, dispose } = await setup()
    const opened = await ctx.tools.invoke('contract_open', {
      title: '交付 V1', goals: [], nonGoals: [], acceptance,
    }, { sessionId: meta.id })
    const id = contractOf(ctx, meta.id).open!.id

    const closed = await ctx.tools.invoke('contract_close', { id, reason: '已验收' }, { sessionId: meta.id })
    expect(closed.isError).toBe(false)
    expect(contractOf(ctx, meta.id).open).toBeNull()

    const reopened = await ctx.tools.invoke('contract_open', {
      title: '交付 V2', goals: [], nonGoals: [], acceptance,
    }, { sessionId: meta.id })
    expect(reopened.isError).toBe(false)
    expect(contractOf(ctx, meta.id).open?.title).toBe('交付 V2')
    expect(opened.isError).toBe(false)

    await dispose()
  })

  it('carries the contract across fork', async () => {
    const { ctx, meta, dispose } = await setup()
    await ctx.tools.invoke('contract_open', {
      title: '交付 V1', goals: [], nonGoals: [], acceptance,
    }, { sessionId: meta.id })

    const fork = ctx.sessions.fork(meta.id)
    expect(contractOf(ctx, fork.id).open?.title).toBe('交付 V1')

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
    const meta = ctx.sessions.create()

    await ctx.tools.invoke('contract_open', {
      title: '交付 V1', goals: [], nonGoals: [], acceptance,
    }, { sessionId: meta.id })
    expect(ctx.sessions.view(meta.id)?.[CONTRACT_PROJECTION]).toBeTruthy()

    await contract.dispose()
    expect(ctx.sessions.view(meta.id)?.[CONTRACT_PROJECTION]).toBeUndefined()

    await tools.dispose()
    await sessions.dispose()
  })
})
