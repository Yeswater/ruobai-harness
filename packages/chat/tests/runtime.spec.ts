import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@ruobai/cordis'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

async function setup(delay = 5) {
  const harness = await createHarness({ delay })
  harnesses.push(harness)
  return harness.ctx
}

function turnsEnded(ctx: Context, count: number) {
  return new Promise<void>((resolve) => {
    let seen = 0
    ctx.on('chat/event', (event) => {
      if (event.type !== 'message-done') return
      seen += 1
      if (seen >= count) resolve()
    })
  })
}

function userTexts(ctx: Context, sessionId: string) {
  return ctx.sessions.get(sessionId)!.events
    .filter(event => event.type === 'message/user')
    .map(event => (event.data as { text: string }).text)
}

describe('running session', () => {
  it('queues a message sent mid-turn and runs it as the next turn', async () => {
    const ctx = await setup()
    const session = ctx.chat.create('queue')
    const ended = turnsEnded(ctx, 2)

    const first = ctx.chat.send(session.id, '第一条')
    expect(first.queued).toBe(false)

    const second = ctx.chat.send(session.id, '第二条')
    expect(second.queued).toBe(true)
    // The queued text is shown from the queue, not the log: nothing may leak
    // into the turn the model is still producing.
    expect(ctx.chat.get(session.id)?.queued?.map(item => item.id)).toEqual([second.message.id])
    expect(userTexts(ctx, session.id)).toEqual(['第一条'])

    await ended
    expect(userTexts(ctx, session.id)).toEqual(['第一条', '第二条'])
    const final = ctx.chat.get(session.id)!
    expect(final.queued).toBeUndefined()
    expect(final.streaming).toBe(false)
  })

  it('keeps queued messages when the running turn is stopped', async () => {
    const ctx = await setup()
    const session = ctx.chat.create('stop')
    const ended = turnsEnded(ctx, 2)

    ctx.chat.send(session.id, '第一条')
    expect(ctx.chat.send(session.id, '第二条').queued).toBe(true)
    ctx.chat.stop(session.id)

    // Esc keeps the queue: the interrupted turn ends, the next one starts.
    await ended
    expect(userTexts(ctx, session.id)).toEqual(['第一条', '第二条'])
    expect(ctx.chat.get(session.id)?.queued).toBeUndefined()
  })

  it('takes a queued message back before its turn starts', async () => {
    const ctx = await setup()
    const session = ctx.chat.create('withdraw')
    const ended = turnsEnded(ctx, 1)

    ctx.chat.send(session.id, '第一条')
    const queued = ctx.chat.send(session.id, '第二条')
    const taken = ctx.chat.withdraw(session.id, queued.message.id)
    expect(taken.text).toBe('第二条')
    expect(ctx.chat.get(session.id)?.queued).toBeUndefined()

    await ended
    // The withdrawn entry must not start a turn of its own.
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(userTexts(ctx, session.id)).toEqual(['第一条'])
  })

  it('folds a queued message into the running turn at the next step boundary', async () => {
    const ctx = await setup(30)
    const session = ctx.chat.create('interject')
    let turns = 0
    ctx.on('agent/turn-end', () => { turns += 1 })

    // The mock's file branch calls a tool first: the step boundary only opens
    // once that tool has returned.
    ctx.chat.send(session.id, '看一下文件')
    expect(ctx.chat.send(session.id, '顺便说一下第二条').queued).toBe(true)

    for (let attempt = 0; attempt < 400 && ctx.agents.isRunning(session.id); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await new Promise(resolve => setTimeout(resolve, 60))

    // One turn, not two: the queued message was read inside it.
    expect(turns).toBe(1)
    expect(userTexts(ctx, session.id)).toEqual(['看一下文件', '顺便说一下第二条'])
    expect(ctx.chat.get(session.id)?.queued).toBeUndefined()

    // And it was admitted before the turn ended, i.e. an assistant step still
    // followed it.
    const events = ctx.sessions.get(session.id)!.events
    const admitted = events.findIndex(event =>
      event.type === 'message/user' && event.data.text === '顺便说一下第二条')
    const lastAssistant = events.map(event => event.type).lastIndexOf('message/assistant')
    expect(admitted).toBeGreaterThan(0)
    expect(admitted).toBeLessThan(lastAssistant)
  })

  it('applies a permission change made mid-turn', async () => {
    const ctx = await setup()
    const session = ctx.chat.create('live-permission')
    const ended = turnsEnded(ctx, 1)

    ctx.chat.send(session.id, '你好')
    expect(ctx.permissions.modeFor(session.id)).toBe('workspace-write')

    ctx.chat.setPermission(session.id, 'read-only')
    expect(ctx.permissions.modeFor(session.id)).toBe('read-only')
    expect(ctx.chat.get(session.id)?.permission).toBe('read-only')

    await ended
  })

  it('accepts full access as the global default', async () => {
    const ctx = await setup()
    await ctx.settings.update({ agent: { defaultPermission: 'full-access' } })

    const session = ctx.chat.create('global-default')
    expect(ctx.chat.get(session.id)?.permission).toBe('full-access')
    expect(ctx.permissions.modeFor(session.id)).toBe('full-access')
    expect(ctx.permissions.approval(session.id, 'bash')).toBe('allow')
  })
})
