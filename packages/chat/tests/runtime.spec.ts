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

  it('sends a queued message now by interrupting the turn', async () => {
    const ctx = await setup(30)
    const session = ctx.chat.create('send-now')
    const ended = turnsEnded(ctx, 2)

    ctx.chat.send(session.id, '第一条')
    const queued = ctx.chat.send(session.id, '第二条')
    expect(ctx.agents.isRunning(session.id)).toBe(true)

    ctx.chat.sendNow(session.id, queued.message.id)
    await ended
    expect(userTexts(ctx, session.id)).toEqual(['第一条', '第二条'])
    expect(ctx.chat.get(session.id)?.queued).toBeUndefined()
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
