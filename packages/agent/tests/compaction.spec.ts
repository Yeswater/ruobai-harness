import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import type { Message } from '@ruobai/llm'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

function systemText(messages: Message[]) {
  return messages[0]?.role === 'system'
    ? messages[0].content.map(part => part.type === 'text' ? part.text : '').join('')
    : ''
}

function isSummaryRequest(messages: Message[]) {
  return systemText(messages).includes('compaction engine')
}

function nextDone(ctx: Harness['ctx']) {
  return new Promise<ChatSession>((resolve) => {
    ctx.on('chat/event', (event) => {
      if (event.type === 'message-done') resolve(event.session)
    })
  })
}

type Reply = string | { error: string }

async function scripted(ctx: Harness['ctx'], reply: (messages: Message[]) => Reply) {
  const seen: Message[][] = []
  ctx.effect(() => ctx.llm.register({
    name: 'scripted',
    models: ['scripted-1'],
    async *stream(request) {
      seen.push(request.messages)
      const result = reply(request.messages)
      if (typeof result === 'string') yield { type: 'text-delta' as const, text: result }
      else yield { type: 'error' as const, message: result.error }
      yield { type: 'done' as const, reason: 'stop' as const }
    },
  }))
  await ctx.settings.update({ llm: { activeProvider: 'scripted', activeModel: 'scripted-1' } })
  return seen
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'rbh-agent-compact-'))
  dirs.push(dir)
  return dir
}

function seedHistory(ctx: Harness['ctx'], id: string, count = 10) {
  for (let index = 0; index < count; index += 1) {
    ctx.sessions.append(id, 'message/user', {
      id: `seed-${index}`,
      text: `requirement ${index}: ${'x'.repeat(300)}`,
      at: index,
    })
  }
}

function textOf(session: ChatSession) {
  return JSON.stringify(session.messages)
}

describe('agent compaction', () => {
  it('handles /compact without calling the main model', async () => {
    const harness = await createHarness({ context: { retainTokens: 40, keepRecent: 3 } })
    harnesses.push(harness)
    const dir = await workspace()
    const seen = await scripted(harness.ctx, messages =>
      isSummaryRequest(messages)
        ? '## Primary Request and Intent\n- continue the task'
        : 'should not be called')

    const session = harness.ctx.chat.create(undefined, 'agent', dir)
    seedHistory(harness.ctx, session.id)

    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, '/compact keep the API stable')
    const final = await done

    expect(seen).toHaveLength(1)
    expect(seen[0]!.some(message => JSON.stringify(message).includes('## User Messages'))).toBe(true)
    expect(seen[0]!.some(message => JSON.stringify(message).includes('keep the API stable'))).toBe(true)

    const events = harness.ctx.sessions.get(session.id)!.events
    expect(events.some(event => event.type === 'context/summary')).toBe(true)
    expect(textOf(final)).toContain('上下文已压缩')
    expect(textOf(final)).not.toContain('should not be called')
  })

  it('recovers from a provider context overflow by compacting and retrying once', async () => {
    const harness = await createHarness({ context: { retainTokens: 40, keepRecent: 3 } })
    harnesses.push(harness)
    const dir = await workspace()
    let mainCalls = 0
    const seen = await scripted(harness.ctx, (messages) => {
      if (isSummaryRequest(messages)) return '## Primary Request and Intent\n- continue'
      mainCalls += 1
      if (mainCalls === 1) return { error: "This model's maximum context length is 128000 tokens" }
      return 'recovered'
    })

    const session = harness.ctx.chat.create(undefined, 'agent', dir)
    seedHistory(harness.ctx, session.id)

    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, 'finish the task')
    const final = await done

    expect(seen).toHaveLength(3)
    expect(textOf(final)).toContain('recovered')
    expect(textOf(final)).toContain('上下文已压缩（溢出恢复）')
    expect(harness.ctx.sessions.get(session.id)!.events
      .some(event => event.type === 'context/summary')).toBe(true)
  })

  it('continues the turn when summarization fails', async () => {
    const harness = await createHarness({ context: { retainTokens: 40, keepRecent: 3 } })
    harnesses.push(harness)
    await harness.ctx.settings.update({ agent: { compactAt: 100 } })
    const dir = await workspace()
    await scripted(harness.ctx, messages => isSummaryRequest(messages)
      ? { error: 'summarizer unavailable' }
      : 'still working')

    const session = harness.ctx.chat.create(undefined, 'agent', dir)
    seedHistory(harness.ctx, session.id)

    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, 'go')
    const final = await done

    expect(textOf(final)).toContain('still working')
    expect(harness.ctx.sessions.get(session.id)!.events
      .some(event => event.type === 'context/summary')).toBe(false)
    const info = await harness.ctx.context.info(session.id)
    expect(info.compaction.failures).toBeGreaterThan(0)
  })
})
