import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ToolRegistry from '@ruobai/tools'
import A2aService from '../src/index.ts'
import { mergeA2aConfigs, readA2aConfig } from '../src/config.ts'
import { fetchAgentCard } from '../src/card.ts'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface Fixture {
  base: string
  server: Server
  mode: { value: 'message' | 'task' | 'legacy' }
  taskPolls: number
}

async function startAgent(): Promise<Fixture> {
  const fixture: Fixture = {
    base: '',
    mode: { value: 'message' },
    taskPolls: 0,
    server: undefined as unknown as Server,
  }
  const server = createServer((req, res) => { void handle(fixture, req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  fixture.server = server
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  fixture.base = `http://127.0.0.1:${port}`
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return fixture
}

async function handle(fixture: Fixture, req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
    if (fixture.mode.value === 'legacy') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      name: 'Reviewer',
      description: 'Reviews changes',
      url: `${fixture.base}/rpc`,
      skills: [{ id: 'review', name: 'Code review', description: 'Review a diff' }],
    }))
    return
  }
  if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: 'Legacy Reviewer', url: `${fixture.base}/rpc` }))
    return
  }
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = ''
    for await (const chunk of req) body += chunk
    const payload = JSON.parse(body) as { id: string; method: string; params: Record<string, unknown> }
    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }))
    }
    if (payload.method === 'message/send' || payload.method === 'tasks/send') {
      if (fixture.mode.value === 'legacy' && payload.method !== 'tasks/send') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'not found' } }))
        return
      }
      if (fixture.mode.value === 'task' || fixture.mode.value === 'legacy') {
        reply({ kind: 'task', id: 'task-1', status: { state: 'working' } })
      } else {
        reply({ kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'remote reply' }] })
      }
      return
    }
    if (payload.method === 'tasks/get') {
      fixture.taskPolls += 1
      if (fixture.taskPolls < 2) reply({ kind: 'task', id: 'task-1', status: { state: 'working' } })
      else reply({
        kind: 'task',
        id: 'task-1',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ kind: 'text', text: 'artifact reply' }] }],
      })
      return
    }
    if (payload.method === 'tasks/cancel') {
      reply({ kind: 'task', id: 'task-1', status: { state: 'canceled' } })
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'not found' } }))
    return
  }
  res.writeHead(404)
  res.end()
}

async function setupService(config: Record<string, unknown>) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rbh-a2a-ws-'))
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }))
  await mkdir(join(workspaceRoot, '.ruobai'))
  await writeFile(join(workspaceRoot, '.ruobai', 'a2a.json'), JSON.stringify({ agents: [config] }))
  const ctx = new Context()
  const tools = ctx.plugin(ToolRegistry)
  await tools
  cleanups.push(() => tools.dispose())
  const a2a = ctx.plugin(A2aService, {
    workspaceRoot,
    globalRoot: join(workspaceRoot, 'global'),
    watchIntervalMs: 0,
  })
  await a2a
  cleanups.push(() => a2a.dispose())
  await ctx.a2a.reload()
  return { ctx, workspaceRoot }
}

describe('a2a agents', () => {
  it('registers one tool per agent and calls message/send', async () => {
    const agent = await startAgent()
    const { ctx } = await setupService({
      id: 'reviewer',
      url: agent.base,
      allowPrivateHosts: true,
      approval: 'never',
    })

    const tool = ctx.tools.get('a2a__reviewer')
    expect(tool).toBeTruthy()
    expect(tool?.description).toContain('Reviewer')
    expect(tool?.description).toContain('Code review')
    const result = await ctx.tools.invoke('a2a__reviewer', { message: 'check this' }, {})
    expect(result.isError).toBe(false)
    expect(result.content).toBe('remote reply')
    expect(ctx.a2a.info().agents).toEqual([
      expect.objectContaining({ id: 'reviewer', status: 'ok', tool: 'a2a__reviewer' }),
    ])
  })

  it('falls back to the legacy well-known card and tasks/send', async () => {
    const agent = await startAgent()
    agent.mode.value = 'legacy'
    const card = await fetchAgentCard(agent.base, { allowPrivateHosts: true })
    expect(card.name).toBe('Legacy Reviewer')
    const { ctx } = await setupService({
      id: 'legacy',
      url: agent.base,
      allowPrivateHosts: true,
      approval: 'never',
    })
    const result = await ctx.tools.invoke('a2a__legacy', { message: 'go' }, {})
    expect(result.isError).toBe(false)
    expect(result.content).toBe('artifact reply')
  })

  it('polls tasks until completed', async () => {
    const agent = await startAgent()
    agent.mode.value = 'task'
    const { ctx } = await setupService({
      id: 'polling',
      url: agent.base,
      allowPrivateHosts: true,
      approval: 'never',
    })
    const result = await ctx.tools.invoke('a2a__polling', { message: 'go' }, {})
    expect(result.isError).toBe(false)
    expect(result.content).toBe('artifact reply')
    expect(agent.taskPolls).toBeGreaterThanOrEqual(2)
  })

  it('rejects private hosts unless explicitly allowed', async () => {
    const agent = await startAgent()
    const { ctx } = await setupService({
      id: 'private',
      url: agent.base,
      approval: 'never',
    })
    expect(ctx.tools.get('a2a__private')).toBeUndefined()
    expect(ctx.a2a.info().agents[0]).toMatchObject({
      id: 'private',
      status: 'error',
    })
    expect(ctx.a2a.info().agents[0]?.error).toContain('private')
  })

  it('merges project config over the global file', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'rbh-a2a-merge-'))
    const globalRoot = await mkdtemp(join(tmpdir(), 'rbh-a2a-global-'))
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }))
    cleanups.push(() => rm(globalRoot, { recursive: true, force: true }))
    await mkdir(join(workspaceRoot, '.ruobai'))
    await writeFile(join(workspaceRoot, '.ruobai', 'a2a.json'), JSON.stringify({
      agents: [{ id: 'shared', url: 'https://project.example.com/a2a' }],
    }))
    await writeFile(join(globalRoot, 'a2a.json'), JSON.stringify({
      agents: [{ id: 'shared', url: 'https://global.example.com/a2a' }, { id: 'global-only', url: 'https://g.example.com' }],
    }))
    const project = await readA2aConfig(join(workspaceRoot, '.ruobai', 'a2a.json'))
    const global = await readA2aConfig(join(globalRoot, 'a2a.json'))
    const merged = mergeA2aConfigs([{ path: 'project', agents: project }, { path: 'global', agents: global }])
    expect(merged.map(agent => [agent.id, agent.url])).toEqual([
      ['shared', 'https://project.example.com/a2a'],
      ['global-only', 'https://g.example.com'],
    ])
  })

  it('exposes status through the web API', async () => {
    const harness: Harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const agent = await startAgent()
    await mkdir(join(harness.dir, '.ruobai'), { recursive: true })
    await writeFile(join(harness.dir, '.ruobai', 'a2a.json'), JSON.stringify({
      agents: [{ id: 'web', url: agent.base, allowPrivateHosts: true, approval: 'never' }],
    }))
    await harness.ctx.a2a.reload()
    const body = await (await fetch(`${harness.ctx.web.url}/api/a2a`)).json() as {
      agents: Array<{ id: string; status: string }>
    }
    expect(body.agents).toEqual([expect.objectContaining({ id: 'web', status: 'ok' })])
  })
})
