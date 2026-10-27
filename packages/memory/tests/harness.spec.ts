import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('memory and wiki in the full stack', () => {
  it('injects saved memory into a new session and serves wiki searches', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const session = ctx.sessions.create({ workspace: dir })

    await ctx.memory.save({
      text: '用户偏好中文回复，提交信息用中文摘要',
      kind: 'preference',
    }, session.id)

    const first = await ctx.context.build(session.id, { basePrompt: 'base prompt' })
    expect(first.system).toContain('<long_term_memory>')
    expect(first.system).toContain('用户偏好中文回复')
    expect(ctx.sessions.get(session.id)!.events.some(event => event.type === 'memory/injected')).toBe(true)

    await ctx.wiki.write({
      id: 'sandbox-seatbelt',
      title: 'macOS Seatbelt 沙箱',
      body: [
        '## 摘要',
        '',
        'Seatbelt 沙箱只接受 * 或 localhost 作为网络主机。',
        '',
        '## 事实',
        '',
        '- 嵌套 sandbox-exec 会 exit 71。',
      ].join('\n'),
      sources: [{ kind: 'file', path: 'docs/sandbox-macos.md' }],
    }, session.id)

    const second = ctx.sessions.create({ workspace: dir })
    const built = await ctx.context.build(second.id, { basePrompt: 'base prompt' })
    expect(built.system).toContain('<long_term_memory>')
    expect(built.system).toContain('<wiki_catalog>')
    expect(built.system).toContain('sandbox-seatbelt')

    const found = await ctx.tools.invoke('wiki_search', { query: '沙箱' }, { sessionId: second.id })
    expect(found.isError).toBe(false)
    expect(found.content).toContain('sandbox-seatbelt')

    const page = await ctx.tools.invoke('wiki_read', {
      page: 'sandbox-seatbelt',
      level: 'summary',
    }, { sessionId: second.id })
    expect(page.isError).toBe(false)
    expect(page.content).toContain('Seatbelt')
  })

  it('keeps the memory section byte-stable within a session', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const session = ctx.sessions.create({ workspace: dir })

    await ctx.memory.save({ text: '第一条长期记忆', kind: 'fact' }, session.id)
    const before = await ctx.context.build(session.id, { basePrompt: 'base' })
    expect(before.system).toContain('第一条长期记忆')

    await ctx.memory.save({ text: '第二条长期记忆', kind: 'fact' }, session.id)
    const after = await ctx.context.build(session.id, { basePrompt: 'base' })
    expect(after.system).toContain('第一条长期记忆')
    expect(after.system).not.toContain('第二条长期记忆')
    expect(after.fingerprint.system).toBe(before.fingerprint.system)
  })
})
