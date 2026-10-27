import { afterEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '@ruobai/llm'
import { parseDraft } from '../src/index.ts'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for condition')
}

describe('wiki automation', () => {
  it('injects recall only when the switch is on', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    await harness.ctx.wiki.write({
      title: 'Seatbelt rules',
      body: '## 摘要\n\n嵌套 sandbox-exec 会 exit 71。\n\n## 事实\n\nSeatbelt 只允许 localhost。',
      sources: [{ kind: 'session', session: session.id }],
    }, session.id)
    harness.ctx.sessions.append(session.id, 'message/user', { text: '请解释 Seatbelt 沙箱的规则' })

    const off = await harness.ctx.context.build(session.id, { basePrompt: 'base' })
    expect(off.system).not.toContain('<wiki_recall>')

    await harness.ctx.settings.updateWiki({ recall: true })
    const on = await harness.ctx.context.build(session.id, { basePrompt: 'base' })
    expect(on.system).toContain('<wiki_recall>')
    expect(on.system).toContain('seatbelt-rules')
    expect(harness.ctx.sessions.get(session.id)!.events.some(event => event.type === 'wiki/recalled')).toBe(true)

    const again = await harness.ctx.context.build(session.id, { basePrompt: 'base' })
    expect(again.system).toBe(on.system)
  })

  it('drafts a proposal after idle without writing a page', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    const provider: LlmProvider = {
      name: 'fake',
      models: ['fake-1'],
      async *stream() {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            title: 'Seatbelt 网络规则',
            body: '## 摘要\n\n沙箱只允许 localhost。\n\n## 事实\n\n嵌套 sandbox-exec 会 exit 71。',
            tags: ['sandbox'],
          }),
        }
        yield { type: 'done', reason: 'stop' }
      },
    }
    const unregister = harness.ctx.llm.register(provider)
    harness.ctx.sessions.setModel(session.id, 'fake', 'fake-1')
    await harness.ctx.settings.updateWiki({ distill: true })

    harness.ctx.sessions.append(session.id, 'message/user', {
      text: '把沙箱只允许 localhost、嵌套 sandbox-exec 会 exit 71 这条结论写进知识库。'.repeat(4),
    })
    harness.ctx.sessions.append(session.id, 'message/assistant', {
      parts: [{ type: 'text', text: '结论：默认网络关闭，只允许 localhost；嵌套 sandbox-exec 会 exit 71。'.repeat(4) }],
    })
    harness.ctx.emit('agent/turn-end', session.id, 'done')

    await waitFor(() => harness.ctx.sessions.get(session.id)!.events
      .some(event => event.type === 'wiki/proposed' && event.data?.status === 'ready'))
    expect(await harness.ctx.wiki.pages(session.id)).toEqual([])
    const proposals = await harness.ctx.wiki.proposals(session.id)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.title).toBe('Seatbelt 网络规则')
    unregister()
  })
})

describe('parseDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(parseDraft('{"title":"A","body":"## 摘要\\n\\nx","tags":["t"]}')).toEqual({
      skip: false,
      title: 'A',
      body: '## 摘要\n\nx',
      tags: ['t'],
    })
  })

  it('accepts an explicit skip', () => {
    expect(parseDraft('{"skip":true}')).toEqual({ skip: true, title: '', body: '', tags: [] })
  })

  it('rejects a body without the summary heading', () => {
    expect(() => parseDraft('{"title":"A","body":"x"}')).toThrow(/摘要/)
  })
})
