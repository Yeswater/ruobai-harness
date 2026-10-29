import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'
import { planOf } from '../src/index.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const PLAN = [
  '## 登录页拆分',
  '',
  '1. 抽出表单组件',
  '2. 表单接到路由',
  '3. 跑类型检查',
].join('\n')

async function setup(mode = 'plan') {
  harness = await createHarness()
  const ctx = harness.ctx
  const session = ctx.sessions.create({ title: '登录页拆分', mode })
  return { ctx, sessionId: session.id }
}

describe('plan submission', () => {
  it('records the plan and waits for the user', async () => {
    const { ctx, sessionId } = await setup()
    const frames: Array<{ sessionId: string; title: string }> = []
    const off = ctx.on('plan/requested', proposal => frames.push(proposal))

    const result = await ctx.tools.invoke('plan_submit', { title: '登录页拆分', plan: PLAN }, { sessionId })
    off()

    expect(result.isError).toBe(false)
    expect(result.content).toContain('等待确认')
    expect(frames).toHaveLength(1)
    expect(planOf(ctx, sessionId).proposal).toMatchObject({
      sessionId,
      title: '登录页拆分',
      plan: PLAN,
    })
    // The pending plan survives a reload because it is in the session log.
    expect(ctx.sessions.get(sessionId)!.events.some(event => event.type === 'plan/proposed')).toBe(true)
  })

  it('falls back to the first heading as the title', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('plan_submit', { plan: PLAN }, { sessionId })
    expect(planOf(ctx, sessionId).proposal?.title).toBe('登录页拆分')
  })

  it('rejects an empty plan without writing anything', async () => {
    const { ctx, sessionId } = await setup()
    const result = await ctx.tools.invoke('plan_submit', { plan: '   ' }, { sessionId })
    expect(result.isError).toBe(true)
    expect(planOf(ctx, sessionId).proposal).toBeNull()
    expect(ctx.sessions.get(sessionId)!.events.some(event => event.type === 'plan/proposed')).toBe(false)
  })
})

describe('plan decisions over HTTP', () => {
  it('serves the pending plan and starts executing on accept', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('plan_submit', { plan: PLAN }, { sessionId })
    const base = ctx.web.url

    const listed = await fetch(`${base}/api/plans?sessionId=${sessionId}`)
      .then(response => response.json() as Promise<{ plan: { id: string; title: string } | null }>)
    expect(listed.plan?.title).toBe('登录页拆分')

    const accepted = await fetch(`${base}/api/plans/${listed.plan!.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action: 'accept' }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ ok: true, action: 'accept' })

    // The card is gone and the decision is durable.
    expect(planOf(ctx, sessionId).proposal).toBeNull()
    // Plan mode cannot write; accepting moves to the mode that can.
    expect(ctx.sessions.get(sessionId)!.meta.mode).toBe('agent')
    expect(userMessages(ctx, sessionId).at(-1)).toContain('按上面的计划开始执行')
  })

  it('sends the feedback back and stays in Plan mode on revise', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('plan_submit', { plan: PLAN }, { sessionId })
    const proposal = planOf(ctx, sessionId).proposal!
    const base = ctx.web.url

    const revised = await fetch(`${base}/api/plans/${proposal.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action: 'revise', feedback: '先补一个回滚方案' }),
    })
    expect(revised.status).toBe(200)
    expect(ctx.sessions.get(sessionId)!.meta.mode).toBe('plan')
    expect(userMessages(ctx, sessionId).at(-1)).toContain('先补一个回滚方案')
  })

  it('answers 404 for a plan that is already decided', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('plan_submit', { plan: PLAN }, { sessionId })
    const proposal = planOf(ctx, sessionId).proposal!
    const base = ctx.web.url
    const body = JSON.stringify({ sessionId, action: 'revise' })

    await fetch(`${base}/api/plans/${proposal.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const again = await fetch(`${base}/api/plans/${proposal.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(again.status).toBe(404)
  })

  it('pushes the card and its resolution on the ui channel', async () => {
    const { ctx, sessionId } = await setup()
    const frames: Array<{ kind: string; proposal?: { sessionId: string } }> = []
    const off = ctx.on('ui/broadcast', (channel, data) => {
      if (channel === 'plan') frames.push(data as (typeof frames)[number])
    })

    await ctx.tools.invoke('plan_submit', { plan: PLAN }, { sessionId })
    const proposal = planOf(ctx, sessionId).proposal!
    await fetch(`${ctx.web.url}/api/plans/${proposal.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action: 'revise' }),
    })
    off()

    expect(frames.map(frame => frame.kind)).toEqual(['requested', 'resolved'])
    expect(frames[0]).toMatchObject({ proposal: { sessionId } })
  })
})

function userMessages(ctx: Harness['ctx'], sessionId: string) {
  return ctx.sessions.get(sessionId)!.events
    .filter(event => event.type === 'message/user')
    .map(event => String((event.data as { text?: string }).text ?? ''))
}
