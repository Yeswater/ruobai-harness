import { afterEach, describe, expect, it } from 'vitest'
import { todoOf } from '@ruobai/todo'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined
const cleanups: Array<() => void> = []

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!()
  await harness?.dispose()
  harness = undefined
})

async function setup() {
  harness = await createHarness()
  const { ctx, dir } = harness
  const session = ctx.sessions.create({ workspace: dir })
  return { ctx, sessionId: session.id, dir }
}

describe('todo', () => {
  it('records the list as an event and exposes it to the prompt', async () => {
    const { ctx, sessionId } = await setup()

    const result = await ctx.tools.invoke('todo_write', {
      tasks: [
        { id: '1', text: '读现有实现', status: 'completed' },
        { id: '2', text: '改投影', status: 'in_progress' },
        { id: '3', text: '跑测试', status: 'pending' },
      ],
    }, { sessionId })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('1/3 completed')
    expect(ctx.sessions.get(sessionId)!.events.some(event => event.type === 'todo/updated')).toBe(true)

    const state = todoOf(ctx, sessionId)
    expect(state.rev).toBe(1)
    expect(state.items).toMatchObject([
      { id: '1', status: 'completed' },
      { id: '2', status: 'in_progress' },
      { id: '3', status: 'pending' },
    ])

    const built = await ctx.context.build(sessionId, { basePrompt: 'base' })
    expect(built.system).toContain('<task_list>')
    expect(built.system).toContain('[>] 改投影')
  })

  it('tells the model to keep a list before any list exists', async () => {
    const { ctx, sessionId } = await setup()
    const built = await ctx.context.build(sessionId, { basePrompt: 'base' })
    // The panel can only appear if the model calls the tool; the rule has to
    // be in the prompt before the first step, not only in the tool description.
    expect(built.system).toContain('多步任务维护任务清单')
    expect(built.system).toContain('todo_write')
  })

  it('replaces rather than merges, and clears with an empty list', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('todo_write', {
      tasks: [{ id: '1', text: 'a', status: 'pending' }],
    }, { sessionId })
    await ctx.tools.invoke('todo_write', {
      tasks: [{ id: '2', text: 'b', status: 'in_progress' }],
    }, { sessionId })

    expect(todoOf(ctx, sessionId).items).toMatchObject([{ id: '2', text: 'b' }])
    expect(todoOf(ctx, sessionId).rev).toBe(2)

    const cleared = await ctx.tools.invoke('todo_write', { tasks: [] }, { sessionId })
    expect(cleared.isError).toBe(false)
    expect(todoOf(ctx, sessionId).items).toEqual([])
  })

  it('rejects malformed lists without writing an event', async () => {
    const { ctx, sessionId } = await setup()

    const twoActive = await ctx.tools.invoke('todo_write', {
      tasks: [
        { text: 'a', status: 'in_progress' },
        { text: 'b', status: 'in_progress' },
      ],
    }, { sessionId })
    expect(twoActive.isError).toBe(true)
    expect(twoActive.content).toContain('one task may be in progress')

    const duplicate = await ctx.tools.invoke('todo_write', {
      tasks: [
        { id: 'x', text: 'a', status: 'pending' },
        { id: 'x', text: 'b', status: 'pending' },
      ],
    }, { sessionId })
    expect(duplicate.isError).toBe(true)

    expect(ctx.sessions.get(sessionId)!.events.some(event => event.type === 'todo/updated')).toBe(false)
  })

  it('pushes the new list on the ui channel', async () => {
    const { ctx, sessionId } = await setup()
    const frames: Array<{ sessionId: string; rev: number; items: unknown[] }> = []
    const off = ctx.on('ui/broadcast', (channel, data) => {
      if (channel === 'todo') frames.push(data as typeof frames[number])
    })
    cleanups.push(off)

    await ctx.tools.invoke('todo_write', {
      tasks: [{ id: '1', text: '推送', status: 'in_progress' }],
    }, { sessionId })

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      sessionId,
      rev: 1,
      items: [{ id: '1', text: '推送', status: 'in_progress' }],
    })
  })

  it('serves the snapshot over HTTP for the panel', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.tools.invoke('todo_write', {
      tasks: [{ id: '1', text: '写文档', status: 'in_progress' }],
    }, { sessionId })

    const response = await fetch(`${ctx.web.url}/api/todo?sessionId=${sessionId}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      sessionId,
      rev: 1,
      items: [{ id: '1', text: '写文档', status: 'in_progress' }],
    })

    const missing = await fetch(`${ctx.web.url}/api/todo`)
    expect(missing.status).toBe(400)
    const unknown = await fetch(`${ctx.web.url}/api/todo?sessionId=nope`)
    expect(unknown.status).toBe(404)
  })
})
