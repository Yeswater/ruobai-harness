import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import type { Context } from '@ruobai/cordis'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

async function setup(delay = 0) {
  const harness = await createHarness({ delay })
  harnesses.push(harness)
  return harness.ctx
}

function nextDone(ctx: Context) {
  return new Promise<ChatSession>((resolve) => {
    ctx.on('chat/event', (event) => {
      if (event.type === 'message-done') resolve(event.session)
    })
  })
}

describe('chat bridge', () => {
  it('projects a streamed assistant reply into the UI model', async () => {
    const ctx = await setup()
    const session = ctx.chat.create()
    const done = nextDone(ctx)

    const user = ctx.chat.send(session.id, '你好')
    expect(user.role).toBe('user')

    const final = await done
    expect(final.streaming).toBe(false)
    expect(final.mode).toBe('agent')
    expect(final.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(final.messages[1]?.blocks.some(block => block.type === 'text' && block.text.length > 0)).toBe(true)

    const summary = ctx.chat.list()[0]!
    expect(summary.title).toBe('你好')
    expect(summary.messageCount).toBe(2)
    expect(summary.mode).toBe('agent')
  })

  it('runs a tool call and attaches the result to the tool block', async () => {
    const ctx = await setup()
    const session = ctx.chat.create('tools')
    const done = nextDone(ctx)

    ctx.chat.send(session.id, '看一下文件')
    const final = await done

    const assistants = final.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(2)

    const tool = final.messages
      .flatMap(message => message.blocks)
      .find(block => block.type === 'tool')
    expect(tool?.type).toBe('tool')
    if (tool?.type === 'tool') {
      expect(tool.name).toBe('read_file')
      expect(tool.isError).toBe(false)
      expect(tool.output).toContain('"name"')
    }
  })

  it('streams model thinking as a reasoning block before the answer', async () => {
    const ctx = await setup()
    const session = ctx.chat.create('thinking')
    const deltas: string[] = []
    ctx.on('chat/event', (event) => {
      if (event.type === 'message-reasoning') deltas.push(event.delta)
    })
    const done = nextDone(ctx)

    ctx.chat.send(session.id, '看一下文件')
    const final = await done

    const reasoning = final.messages
      .flatMap(message => message.blocks)
      .find(block => block.type === 'reasoning')
    expect(reasoning?.type).toBe('reasoning')
    if (reasoning?.type === 'reasoning') expect(reasoning.text).toContain('路径')
    expect(deltas.length).toBeGreaterThan(0)
  })

  it('closes the thought as soon as prose starts streaming', async () => {
    const ctx = await setup()
    const session = ctx.chat.create('reasoning-timing')
    // Capture the projection while the step is still live: this is the state
    // that used to read "思考中" until the whole turn ended.
    const live = new Promise<ChatSession>((resolve) => {
      ctx.on('chat/event', (event) => {
        if (event.type === 'message-delta') resolve(ctx.chat.get(session.id)!)
      })
    })
    const done = nextDone(ctx)

    ctx.chat.send(session.id, '看一下文件')
    const midTurn = await live
    const reasoning = midTurn.messages
      .flatMap(message => message.blocks)
      .find(block => block.type === 'reasoning')
    expect(reasoning?.type).toBe('reasoning')
    if (reasoning?.type === 'reasoning') {
      expect(reasoning.startedAt).toBeTypeOf('number')
      expect(reasoning.finishedAt).toBeTypeOf('number')
    }

    // And the settled step keeps that earlier boundary instead of widening it.
    const final = await done
    const settled = final.messages
      .flatMap(message => message.blocks)
      .find(block => block.type === 'reasoning')
    if (settled?.type === 'reasoning' && reasoning?.type === 'reasoning') {
      expect(settled.finishedAt).toBe(reasoning.finishedAt)
    }
  })

  it('stops a running turn', async () => {
    const ctx = await setup(15)
    const session = ctx.chat.create('stop')
    const done = nextDone(ctx)
    ctx.on('agent/step-start', () => ctx.chat.stop(session.id))

    ctx.chat.send(session.id, '写一段很长的话')
    const final = await done
    expect(final.streaming).toBe(false)
  })

  it('switches modes per session', async () => {
    const ctx = await setup()
    const session = ctx.chat.create()
    expect(session.mode).toBe('agent')
    const switched = ctx.chat.setMode(session.id, 'plan')
    expect(switched.mode).toBe('plan')
    expect(ctx.chat.get(session.id)?.mode).toBe('plan')
    expect(() => ctx.chat.setMode(session.id, 'missing')).toThrow()
  })
})
