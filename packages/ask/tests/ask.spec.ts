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
  return { ctx, sessionId: session.id, dir }
}

async function waitFor(check: () => boolean, timeout = 3_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition was not met in time')
}

describe('ask', () => {
  it('blocks the tool until the question is answered', async () => {
    const { ctx, sessionId } = await setup()

    const pending = ctx.tools.invoke('ask_user', {
      question: '本地已有 ~/.memory-tencentdb（10-21，300K）。怎么处理？',
      options: ['复用已有', '重装一份'],
    }, { sessionId })

    await waitFor(() => ctx.ask.list(sessionId).length === 1)
    const [request] = ctx.ask.list(sessionId)
    expect(request.question).toContain('~/.memory-tencentdb')
    expect(request.options).toEqual(['复用已有', '重装一份'])

    expect(ctx.ask.answer(request.id, '复用已有')?.via).toBe('option')

    const result = await pending
    expect(result.isError).toBe(false)
    expect(result.content).toContain('用户回答：复用已有')
    expect(ctx.ask.list(sessionId)).toHaveLength(0)
  })

  it('treats a typed answer that is not one of the options as free text', async () => {
    const { ctx, sessionId } = await setup()
    const pending = ctx.tools.invoke('ask_user', {
      question: '用哪个端口？',
      options: ['8420'],
    }, { sessionId })
    await waitFor(() => ctx.ask.list(sessionId).length === 1)
    const [request] = ctx.ask.list(sessionId)

    expect(ctx.ask.answer(request.id, '9000')?.via).toBe('text')
    expect((await pending).content).toContain('9000')
  })

  it('reports an abort as unanswered instead of consent', async () => {
    const { ctx, sessionId } = await setup()
    const controller = new AbortController()
    const pending = ctx.tools.invoke('ask_user', { question: '要覆盖吗？' }, {
      sessionId,
      signal: controller.signal,
    })
    await waitFor(() => ctx.ask.list(sessionId).length === 1)
    controller.abort()

    const result = await pending
    expect(result.content).toContain('用户中止了本轮')
    expect(result.content).not.toContain('用户回答')
    expect(ctx.ask.list(sessionId)).toHaveLength(0)
  })

  it('rejects an empty answer and keeps the question pending', async () => {
    const { ctx, sessionId } = await setup()
    const pending = ctx.tools.invoke('ask_user', { question: '继续吗？' }, { sessionId })
    await waitFor(() => ctx.ask.list(sessionId).length === 1)
    const [request] = ctx.ask.list(sessionId)

    expect(() => ctx.ask.answer(request.id, '   ')).toThrow(/empty/)
    expect(ctx.ask.list(sessionId)).toHaveLength(1)

    ctx.ask.answer(request.id, '继续')
    await pending
  })

  it('answers over the HTTP surface and pushes the pending question', async () => {
    const { ctx, sessionId } = await setup()
    const base = ctx.web.url
    const pending = ctx.tools.invoke('ask_user', { question: '重装还是复用？' }, { sessionId })

    await waitFor(() => ctx.ask.list(sessionId).length === 1)
    const listed = await (await fetch(`${base}/api/asks?sessionId=${sessionId}`)).json() as {
      asks: Array<{ id: string; question: string }>
    }
    expect(listed.asks).toHaveLength(1)

    const answered = await fetch(`${base}/api/asks/${listed.asks[0]!.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: '复用' }),
    })
    expect(answered.status).toBe(200)
    expect((await pending).content).toContain('用户回答：复用')

    const again = await fetch(`${base}/api/asks/${listed.asks[0]!.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: '复用' }),
    })
    expect(again.status).toBe(404)
  })

  it('puts the check-before-acting rule in the cached prompt prefix', async () => {
    const { ctx, sessionId } = await setup()
    const built = await ctx.context.build(sessionId, { basePrompt: 'base' })
    expect(built.system).toContain('动手前先核对')
    expect(built.system).toContain('ask_user')
  })
})
