import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function setup() {
  harness = await createHarness()
  const { ctx, dir } = harness
  const session = ctx.sessions.create({ workspace: dir })
  return { ctx, sessionId: session.id }
}

const acceptance = [
  {
    id: 'A1',
    criterion: '首页首屏在 2 秒内渲染完成',
    kind: 'auto' as const,
    check: { tool: 'bash' as const, command: 'curl -s localhost:3000', expectExit: 0 },
  },
  { id: 'A2', criterion: '客户能按 runbook 独立重启服务', kind: 'manual' as const },
]

describe('handoff bundle', () => {
  it('serves a manifest with digests for every artifact', async () => {
    const { ctx, sessionId } = await setup()
    const response = await fetch(`${ctx.web.url}/api/handoff/${sessionId}/manifest`)
    expect(response.status).toBe(200)

    const body = await response.json() as {
      generatedFrom: { sessionId: string; upToSeq: number; eventCount: number }
      artifacts: Array<{ name: string; bytes: number; sha256: string }>
    }
    expect(body.generatedFrom.sessionId).toBe(sessionId)
    expect(body.generatedFrom.eventCount).toBeGreaterThan(0)
    expect(body.artifacts.map(artifact => artifact.name)).toEqual([
      'README.md', 'ACCEPTANCE.md', 'CHANGES.md', 'RUNBOOK.md', 'evidence.json',
    ])
    expect(body.artifacts.every(artifact => artifact.sha256.length === 64)).toBe(true)
  })

  it('says the contract is missing instead of inventing acceptance', async () => {
    const { ctx, sessionId } = await setup()
    const response = await fetch(`${ctx.web.url}/api/handoff/${sessionId}/ACCEPTANCE.md`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('未开契约')
  })

  it('renders acceptance rows and the recomputed verdict', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('contract_open', {
      title: '交付 V1', customer: '客户 A', goals: ['上线'], nonGoals: ['不做多租户'], acceptance,
    }, { sessionId })

    const ok = ctx.sessions.append(sessionId, 'tool/result', { callId: 'c1', name: 'bash', content: 'ok', isError: false })
    await ctx.tools.invoke('delivery_claim', {
      items: [{
        acceptanceId: 'A1',
        claim: 'curl returned 200',
        evidence: [{ kind: 'tool', ref: String(ok.seq), seq: ok.seq, summary: 'bash exit 0' }],
      }],
    }, { sessionId })
    await ctx.tools.invoke('delivery_waive', { acceptanceId: 'A2', reason: '客户口头确认' }, { sessionId })

    const acceptanceText = await (await fetch(`${ctx.web.url}/api/handoff/${sessionId}/ACCEPTANCE.md`)).text()
    expect(acceptanceText).toContain('客户 A')
    expect(acceptanceText).toContain('A1')
    expect(acceptanceText).toContain('passed')
    expect(acceptanceText).toContain('**pass**')

    const runbook = await (await fetch(`${ctx.web.url}/api/handoff/${sessionId}/RUNBOOK.md`)).text()
    expect(runbook).toContain('curl -s localhost:3000')
    expect(runbook).toContain('不做多租户')
  })

  it('records written files in the change artifact', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('todo_write', { tasks: [] }, { sessionId })
    ctx.sessions.append(sessionId, 'file/change', {
      path: 'src/app.ts',
      tool: 'edit_file',
      beforeExisted: true,
      afterBytes: 128,
      at: 1_700_000_000_000,
    })

    const text = await (await fetch(`${ctx.web.url}/api/handoff/${sessionId}/CHANGES.md`)).text()
    expect(text).toContain('src/app.ts')
    expect(text).toContain('edit_file')
  })

  it('rejects unknown sessions, artifacts and methods', async () => {
    const { ctx, sessionId } = await setup()

    expect((await fetch(`${ctx.web.url}/api/handoff/nope/manifest`)).status).toBe(404)
    expect((await fetch(`${ctx.web.url}/api/handoff/${sessionId}/passwd`)).status).toBe(404)
    expect((await fetch(`${ctx.web.url}/api/handoff/${sessionId}/manifest`, { method: 'POST' })).status).toBe(405)
  })
})
