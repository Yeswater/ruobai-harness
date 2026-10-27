import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'
import { planQueries } from '../src/index.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('typed queries', () => {
  it('routes by keyword and falls back to all three', () => {
    expect(planQueries('用户偏好是什么').map(query => query.type)).toEqual(['memory'])
    expect(planQueries('知识库里的沙箱页面').map(query => query.type)).toEqual(['wiki'])
    expect(planQueries('怎么弄').map(query => query.type)).toEqual(['memory', 'wiki', 'skill'])
  })
})

describe('context_search', () => {
  it('returns memory, wiki and skill hits in one call', async () => {
    harness = await createHarness()
    const session = harness.ctx.sessions.create({ workspace: harness.dir })

    await harness.ctx.memory.save({
      text: 'Seatbelt 沙箱只接受 localhost',
      kind: 'constraint',
    }, session.id)
    await harness.ctx.wiki.write({
      id: 'sandbox-seatbelt',
      title: 'macOS Seatbelt 沙箱',
      body: '## 摘要\n\nSeatbelt 沙箱只接受 localhost 作为网络主机。',
      sources: [{ kind: 'file', path: 'docs/sandbox-macos.md' }],
    }, session.id)
    await mkdir(join(harness.dir, '.ruobai', 'skills', 'sandbox-check'), { recursive: true })
    await writeFile(
      join(harness.dir, '.ruobai', 'skills', 'sandbox-check', 'SKILL.md'),
      '---\nname: sandbox-check\ndescription: 检查沙箱配置\n---\n\nbody\n',
    )

    const result = await harness.ctx.tools.invoke(
      'context_search',
      { query: '沙箱' },
      { sessionId: session.id },
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('[memory]')
    expect(result.content).toContain('[wiki] sandbox-seatbelt')
    expect(result.content).toContain('[skill] sandbox-check')
  })

  it('respects an explicit type restriction', async () => {
    harness = await createHarness()
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    await harness.ctx.memory.save({ text: '偏好中文回复' }, session.id)
    await harness.ctx.wiki.write({
      id: 'sandbox-seatbelt',
      title: 'Seatbelt',
      body: '## 摘要\n\n沙箱。',
      sources: [{ kind: 'file', path: 'docs/x.md' }],
    }, session.id)

    const result = await harness.ctx.tools.invoke(
      'context_search',
      { query: '沙箱', types: ['wiki'] },
      { sessionId: session.id },
    )
    expect(result.content).toContain('[wiki]')
    expect(result.content).not.toContain('[memory]')
  })
})

describe('skill proposals', () => {
  it('proposes, lists and accepts a skill', async () => {
    harness = await createHarness()
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    const proposed = await harness.ctx.tools.invoke('skill_propose', {
      name: 'release-check',
      description: '发布前检查',
      body: '## 步骤\n\n1. pnpm typecheck\n\n## 校验\n\n- pnpm test',
    }, { sessionId: session.id })
    expect(proposed.isError).toBe(false)

    const base = `${harness.ctx.web.url}/api/skill-proposals?sessionId=${session.id}`
    const listed = await (await fetch(base)).json() as { proposals: Array<{ name: string }> }
    expect(listed.proposals.map(item => item.name)).toEqual(['release-check'])
    expect((await fetch(`${harness.ctx.web.url}/api/skills?sessionId=${session.id}`)).status).toBe(200)

    const accepted = await fetch(`${harness.ctx.web.url}/api/skill-proposals/release-check/accept?sessionId=${session.id}`, {
      method: 'POST',
    })
    expect(accepted.status).toBe(200)
    const skills = await (await fetch(`${harness.ctx.web.url}/api/skills?sessionId=${session.id}`)).json() as {
      skills: Array<{ name: string }>
    }
    expect(skills.skills.map(skill => skill.name)).toContain('release-check')
  })

  it('rejects an invalid skill name', async () => {
    harness = await createHarness()
    const session = harness.ctx.sessions.create({ workspace: harness.dir })
    const result = await harness.ctx.tools.invoke('skill_propose', {
      name: '../escape',
    }, { sessionId: session.id })
    expect(result.isError).toBe(true)
  })
})
