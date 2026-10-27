import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService from '@ruobai/llm'
import MemoryService from '@ruobai/memory'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import WorkspaceService from '@ruobai/workspace'
import { extractRules } from '../src/rules.ts'
import { parseDistill } from '../src/index.ts'
import MemoryDistill, { type Config } from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function waitFor(check: () => Promise<boolean> | boolean, timeout = 3_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

async function setup(config: Config = {}, fakeReply?: string) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rbh-distill-ws-'))
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }))
  const globalRoot = await mkdtemp(join(tmpdir(), 'rbh-distill-home-'))
  cleanups.push(() => rm(globalRoot, { recursive: true, force: true }))

  const ctx = new Context()
  const llm = ctx.plugin(LlmService, { provider: 'mock', model: 'mock-1' })
  await llm
  cleanups.push(() => llm.dispose())
  if (fakeReply !== undefined) {
    const off = ctx.effect(() => ctx.llm.register({
      name: 'fake',
      models: ['fake-1'],
      async *stream() {
        yield { type: 'text-delta', text: fakeReply }
        yield { type: 'done', reason: 'stop' }
      },
    }))
    cleanups.push(async () => off())
  }
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(() => sessions.dispose())
  const workspace = ctx.plugin(WorkspaceService, { root: workspaceRoot })
  await workspace
  cleanups.push(() => workspace.dispose())
  const tools = ctx.plugin(ToolRegistry)
  await tools
  cleanups.push(() => tools.dispose())
  const memory = ctx.plugin(MemoryService, { globalRoot })
  await memory
  cleanups.push(() => memory.dispose())
  const distill = ctx.plugin(MemoryDistill, {
    writeMode: 'rules',
    idleMs: 1,
    minTurns: 1,
    minIntervalMs: 0,
    maxPendingTokens: 100_000,
    ...config,
  })
  await distill
  cleanups.push(() => distill.dispose())

  const session = ctx.sessions.create({ workspace: workspaceRoot })
  return { ctx, sessionId: session.id, workspaceRoot }
}

function userTurn(ctx: Context, sessionId: string, text: string) {
  ctx.sessions.append(sessionId, 'message/user', { text })
  ctx.sessions.append(sessionId, 'message/assistant', {
    parts: [{ type: 'text', text: '好的' }],
  })
}

describe('rules extraction', () => {
  it('takes only explicit signals from user turns', () => {
    const events = [
      { seq: 0, ts: 1, type: 'message/user', data: { text: '记住：提交信息用中文摘要' } },
      { seq: 1, ts: 2, type: 'message/user', data: { text: '以后都走 pnpm' } },
      { seq: 2, ts: 3, type: 'message/user', data: { text: '今天天气不错' } },
      { seq: 3, ts: 4, type: 'message/assistant', data: { parts: [{ type: 'text', text: '记住：用 npm' }] } },
      { seq: 4, ts: 5, type: 'message/user', data: { text: '不要再使用 npm', source: { kind: 'skill' } } },
    ] as any
    expect(extractRules(events)).toEqual([
      { text: '记住：提交信息用中文摘要', kind: 'fact' },
      { text: '以后都走 pnpm', kind: 'decision' },
    ])
  })
})

describe('distillation payload', () => {
  it('validates and clamps model output', () => {
    const payload = parseDistill('```json\n{"add":[{"kind":"constraint","text":"不要使用 npm","tags":["pkg"],"confidence":0.99},{"kind":"bogus","text":"x"}],"update":[],"forget":["mem_1"]}\n```')
    expect(payload.add).toEqual([{ text: '不要使用 npm', kind: 'constraint', tags: ['pkg'], confidence: 0.7 }])
    expect(payload.forget).toEqual(['mem_1'])
    expect(() => parseDistill('not json')).toThrow()
  })
})

describe('memory distill', () => {
  it('commits extracted rules after an idle boundary', async () => {
    const { ctx, sessionId } = await setup()
    userTurn(ctx, sessionId, '记住：提交信息用中文摘要')
    userTurn(ctx, sessionId, '以后都走 pnpm')

    ctx.emit('agent/turn-end', sessionId, 'done')
    await waitFor(async () => (await ctx.memory.items(sessionId)).size === 2)

    const items = [...(await ctx.memory.items(sessionId)).values()]
    expect(items.map(item => item.text).sort()).toEqual(['以后都走 pnpm', '记住：提交信息用中文摘要'].sort())
    expect(items.every(item => item.confidence <= 0.7)).toBe(true)

    const commit = ctx.sessions.get(sessionId)!.events
      .filter(event => event.type === 'memory/commit')
      .at(-1)
    expect(commit?.data).toMatchObject({ status: 'ready', added: 2 })
  })

  it('keeps the newest turn uncommitted for a threshold commit', async () => {
    const { ctx, sessionId } = await setup()
    for (let index = 0; index < 6; index += 1) {
      userTurn(ctx, sessionId, `记住：第 ${index} 条约定`)
    }
    ctx.emit('agent/turn-end', sessionId, 'done')
    await waitFor(async () => (await ctx.memory.items(sessionId)).size === 5)
    const items = [...(await ctx.memory.items(sessionId)).values()]
    expect(items.some(item => item.text.includes('第 5 条'))).toBe(false)
  })

  it('skips a second commit when nothing new arrived', async () => {
    const { ctx, sessionId } = await setup()
    userTurn(ctx, sessionId, '记住：只写一次')
    const readyCommits = () => ctx.sessions.get(sessionId)!.events
      .filter(event => event.type === 'memory/commit' && event.data?.status === 'ready').length

    ctx.emit('agent/turn-end', sessionId, 'done')
    await waitFor(() => readyCommits() === 1)

    ctx.emit('agent/turn-end', sessionId, 'done')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(readyCommits()).toBe(1)
  })

  it('applies a validated LLM response within the confidence cap', async () => {
    const reply = JSON.stringify({
      add: [{ kind: 'constraint', text: '不要使用 npm', tags: ['pkg'], confidence: 0.95 }],
      update: [],
      forget: [],
    })
    const { ctx, sessionId } = await setup({
      writeMode: 'llm',
      provider: 'fake',
      model: 'fake-1',
      idleMs: 1,
    }, reply)
    userTurn(ctx, sessionId, '以后不要用 npm 了')
    ctx.emit('agent/turn-end', sessionId, 'done')

    await waitFor(async () => {
      const items = [...(await ctx.memory.items(sessionId)).values()]
      return items.some(item => item.text === '不要使用 npm')
    })
    const item = [...(await ctx.memory.items(sessionId)).values()]
      .find(entry => entry.text === '不要使用 npm')!
    expect(item.confidence).toBe(0.7)
    expect(ctx.sessions.get(sessionId)!.events.some(event => event.type === 'memory/distill')).toBe(true)
  })

  it('honours the daily call budget', async () => {
    const reply = JSON.stringify({ add: [{ kind: 'fact', text: '预算外', confidence: 0.6 }] })
    const { ctx, sessionId } = await setup({
      writeMode: 'llm',
      provider: 'fake',
      model: 'fake-1',
      idleMs: 1,
      dailyCalls: 0,
    }, reply)
    userTurn(ctx, sessionId, '记住：预算内')
    ctx.emit('agent/turn-end', sessionId, 'done')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect((await ctx.memory.items(sessionId)).size).toBe(0)
    expect(ctx.sessions.get(sessionId)!.events.some(event => event.type === 'memory/commit')).toBe(false)
  })
})
