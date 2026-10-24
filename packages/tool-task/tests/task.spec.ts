import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '@ruobai/llm'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

function textOf(message: any): string {
  return (message?.content ?? [])
    .filter((part: any) => part.type === 'text')
    .map((part: any) => part.text)
    .join('')
}

async function useScripted(ctx: Harness['ctx'], provider: LlmProvider) {
  ctx.effect(() => ctx.llm.register(provider))
  await ctx.settings.update({ llm: { activeProvider: 'scripted', activeModel: 'scripted-1' } })
}

describe('sub-agent', () => {
  it('runs a session to completion and returns its final text', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream() {
        yield { type: 'text-delta', text: 'final answer' }
        yield { type: 'done', reason: 'stop' }
      },
    })

    const session = harness.ctx.sessions.create({ mode: 'agent' })
    const result = await harness.ctx.agents.runToCompletion(session.id, 'do the work')

    expect(result).toEqual({ reason: 'done', text: 'final answer' })
    expect(harness.ctx.agents.isRunning(session.id)).toBe(false)
    const events = harness.ctx.sessions.get(session.id)!.events
    expect(events.some(event => event.type === 'message/user')).toBe(true)
    expect(events.some(event => event.type === 'message/assistant')).toBe(true)
  })

  it('delegates through the task tool and hides the child session', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    const seen: Array<{ text: string; tools: string[] }> = []
    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream(request) {
        const lastUser = [...request.messages].reverse().find(message => message.role === 'user')
        const text = textOf(lastUser)
        seen.push({ text, tools: (request.tools ?? []).map(tool => tool.name) })
        yield {
          type: 'text-delta',
          text: text.includes('child work') ? 'child answer' : 'parent answer',
        }
        yield { type: 'done', reason: 'stop' }
      },
    })

    const parent = harness.ctx.sessions.create({ mode: 'agent' })
    const result = await harness.ctx.tools.invoke(
      'task',
      { description: 'research', prompt: 'child work' },
      { sessionId: parent.id },
    )

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Sub-agent finished (done)')
    expect(result.content).toContain('child answer')
    expect(seen[0]!.text).toContain('child work')
    expect(seen[0]!.tools).not.toContain('task')

    const child = harness.ctx.sessions.list().find(meta => meta.kind === 'subagent')
    expect(child).toMatchObject({ parentId: parent.id })
    expect(harness.ctx.chat.list().map(session => session.id)).not.toContain(child!.id)
    expect(harness.ctx.sessions.has(child!.id)).toBe(true)
  })

  it('refuses to nest sub-agents', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream() {
        yield { type: 'text-delta', text: 'child answer' }
        yield { type: 'done', reason: 'stop' }
      },
    })

    const parent = harness.ctx.sessions.create({ mode: 'agent', kind: 'subagent' })
    const result = await harness.ctx.tools.invoke(
      'task',
      { prompt: 'nested' },
      { sessionId: parent.id },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('cannot spawn sub-agents')
  })

  it('gives the child the parent workspace', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const workspace = await mkdtemp(join(tmpdir(), 'rbh-task-ws-'))
    dirs.push(workspace)

    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream() {
        yield { type: 'text-delta', text: 'child answer' }
        yield { type: 'done', reason: 'stop' }
      },
    })

    const parent = harness.ctx.sessions.create({ mode: 'agent', workspace })
    const result = await harness.ctx.tools.invoke(
      'task',
      { prompt: 'child work' },
      { sessionId: parent.id, workspace },
    )
    expect(result.isError).toBe(false)

    const child = harness.ctx.sessions.list().find(meta => meta.kind === 'subagent')
    expect(child).toMatchObject({ parentId: parent.id, workspace })
  })
})
