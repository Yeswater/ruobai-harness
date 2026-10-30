import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ContractService from '@ruobai/contract'
import DeliveryService from '@ruobai/delivery'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import { analyse } from '../src/index.ts'

const cleanups: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!.dispose()
})

async function setup() {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(sessions as unknown as { dispose(): Promise<void> })
  const tools = ctx.plugin(ToolRegistry)
  await tools
  cleanups.push(tools as unknown as { dispose(): Promise<void> })
  const contract = ctx.plugin(ContractService)
  await contract
  cleanups.push(contract as unknown as { dispose(): Promise<void> })
  const delivery = ctx.plugin(DeliveryService)
  await delivery
  cleanups.push(delivery as unknown as { dispose(): Promise<void> })

  const meta = ctx.sessions.create({ title: 'rubric' })
  return { ctx, sessionId: meta.id }
}

describe('rubric diagnosis', () => {
  it('reports turn errors and guard blocks as rules with evidence', async () => {
    const { ctx, sessionId } = await setup()
    ctx.sessions.append(sessionId, 'turn/error', { message: 'model failed' })
    ctx.sessions.append(sessionId, 'turn/error', { message: 'model failed again' })
    ctx.sessions.append(sessionId, 'hooks/violation', { reason: 'blocked rm -rf' })

    const report = analyse(ctx, sessionId)
    expect(report.failures.map(failure => failure.kind)).toEqual(['turn', 'turn', 'guard'])
    const ids = report.rules.map(rule => rule.id)
    expect(ids).toContain('turn-errors')
    expect(ids).toContain('guard-blocks')
    expect(report.rules.find(rule => rule.id === 'turn-errors')!.evidence).toHaveLength(2)
  })

  it('prefers agent/decision and keeps the reachable tool count', async () => {
    const { ctx, sessionId } = await setup()
    ctx.sessions.append(sessionId, 'agent/decision', {
      chosen: ['read_file', 'edit_file'],
      available: ['read_file', 'edit_file', 'bash', 'todo_write'],
      at: 1,
    })

    const report = analyse(ctx, sessionId)
    expect(report.decisions.map(decision => [decision.tool, decision.available])).toEqual([
      ['read_file', 4],
      ['edit_file', 4],
    ])
  })

  it('counts consecutive tool calls and flags a loop', async () => {
    const { ctx, sessionId } = await setup()
    for (let index = 0; index < 3; index += 1) {
      ctx.sessions.append(sessionId, 'message/assistant', {
        id: `a${index}`,
        parts: [{ type: 'tool-call', id: `c${index}`, name: 'read_file', arguments: '{}' }],
      })
    }

    const report = analyse(ctx, sessionId)
    expect(report.decisions.map(decision => decision.repeat)).toEqual([1, 2, 3])
    expect(report.patterns[0]).toMatchObject({ id: 'repeat-read_file', count: 3 })
    expect(report.rules.some(rule => rule.id === 'repeat-read_file')).toBe(true)
  })

  it('flags a file that keeps being rewritten', async () => {
    const { ctx, sessionId } = await setup()
    for (let index = 0; index < 3; index += 1) {
      ctx.sessions.append(sessionId, 'file/change', {
        path: 'src/app.ts', tool: 'edit_file', beforeExisted: true, afterBytes: 10 + index, at: index,
      })
    }
    const report = analyse(ctx, sessionId)
    expect(report.rules.some(rule => rule.id === 'churn-src/app.ts')).toBe(true)
  })

  it('surfaces manual acceptance items the model cannot sign off', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('contract_open', {
      title: 'V1',
      goals: [],
      nonGoals: [],
      acceptance: [{ id: 'A1', criterion: '客户能重启服务', kind: 'manual' }],
    }, { sessionId })

    const report = analyse(ctx, sessionId)
    expect(report.verdict).toBe('fail')
    const rule = report.rules.find(candidate => candidate.id === 'manual-acceptance')
    expect(rule?.detail).toContain('A1')
  })

  it('returns an empty diagnosis for a clean session', async () => {
    const { ctx, sessionId } = await setup()
    const report = analyse(ctx, sessionId)
    expect(report.rules).toEqual([])
    expect(report.failures).toEqual([])
    expect(report.verdict).toBe('unsure')
  })
})
