import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import ApprovalService from '@ruobai/approval'
import { Context } from '@ruobai/cordis'
import ToolRegistry from '@ruobai/tools'
import McpService, { type McpServerDefinition } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url))
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup(options: { approval?: boolean } = {}) {
  const ctx = new Context()
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const approval = options.approval ? ctx.plugin(ApprovalService) : undefined
  if (approval) await approval
  const mcp = ctx.plugin(McpService)
  await mcp
  cleanups.push(() => mcp.dispose(), () => approval?.dispose(), () => tools.dispose())
  return { ctx }
}

function definition(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: 'fixture',
    label: 'Fixture',
    command: process.execPath,
    args: [fixture],
    timeoutMs: 2_000,
    restart: false,
    ...overrides,
  }
}

function nextRequest(ctx: Context) {
  return new Promise<any>((resolve) => {
    ctx.once('approval/requested', resolve)
  })
}

async function waitFor(check: () => boolean, timeout = 3_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met in time')
}

describe('mcp client', () => {
  it('connects, lists tools and calls a read-only tool without approval', async () => {
    const { ctx } = await setup()
    const status = await ctx.mcp.connect(definition())

    expect(status.status).toBe('connected')
    expect(status.tools).toEqual(expect.arrayContaining(['echo', 'add', 'write_note']))
    expect(ctx.tools.has('mcp__fixture__echo')).toBe(true)
    expect(ctx.tools.has('mcp__fixture__add')).toBe(true)

    const result = await ctx.tools.invoke('mcp__fixture__echo', { text: 'hi' })
    expect(result).toEqual({ content: 'echo:hi', isError: false })

    const sum = await ctx.tools.invoke('mcp__fixture__add', { a: 2, b: 40 })
    expect(sum).toEqual({ content: '42', isError: false })
  })

  it('asks for approval before a tool without read-only annotations', async () => {
    const { ctx } = await setup({ approval: true })
    await ctx.mcp.connect(definition())

    const requested = nextRequest(ctx)
    const pending = ctx.tools.invoke('mcp__fixture__write_note', { text: 'note' })
    const request = await requested
    expect(request.tool).toBe('mcp__fixture__write_note')
    expect(request.summary).toContain('Fixture')
    expect(request.diff).toContain('"text": "note"')

    ctx.approval.resolve(request.id, 'allow')
    await expect(pending).resolves.toEqual({ content: 'wrote:note', isError: false })

    const deniedRequest = nextRequest(ctx)
    const denied = ctx.tools.invoke('mcp__fixture__write_note', { text: 'again' })
    const second = await deniedRequest
    ctx.approval.resolve(second.id, 'deny')
    const result = await denied
    expect(result.isError).toBe(true)
  })

  it('turns an MCP error result into a tool error', async () => {
    const { ctx } = await setup({ approval: true })
    await ctx.mcp.connect(definition())

    const requested = nextRequest(ctx)
    const pending = ctx.tools.invoke('mcp__fixture__fail', {})
    const request = await requested
    ctx.approval.resolve(request.id, 'allow')

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('boom')
  })

  it('times out a tool call and cancels the request', async () => {
    const { ctx } = await setup({ approval: true })
    await ctx.mcp.connect(definition({ timeoutMs: 300 }))

    const requested = nextRequest(ctx)
    const pending = ctx.tools.invoke('mcp__fixture__slow', {})
    const request = await requested
    ctx.approval.resolve(request.id, 'allow')

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out after 300ms')
  })

  it('refreshes tools when the server announces a change', async () => {
    const { ctx } = await setup()
    await ctx.mcp.connect(definition())
    expect(ctx.tools.has('mcp__fixture__extra')).toBe(false)

    const result = await ctx.tools.invoke('mcp__fixture__add_tool', {})
    expect(result.isError).toBe(false)

    await waitFor(() => ctx.tools.has('mcp__fixture__extra'))
    expect(ctx.mcp.get('fixture')?.tools).toContain('extra')
  })

  it('removes tools on disconnect and reconciles through sync', async () => {
    const { ctx } = await setup()
    await ctx.mcp.connect(definition())
    expect(ctx.tools.has('mcp__fixture__echo')).toBe(true)

    await ctx.mcp.disconnect('fixture')
    expect(ctx.tools.has('mcp__fixture__echo')).toBe(false)
    expect(ctx.mcp.get('fixture')).toBeUndefined()

    await ctx.mcp.sync([definition()])
    expect(ctx.mcp.get('fixture')?.status).toBe('connected')
    expect(ctx.tools.has('mcp__fixture__echo')).toBe(true)

    await ctx.mcp.sync([])
    expect(ctx.mcp.get('fixture')).toBeUndefined()
    expect(ctx.tools.has('mcp__fixture__echo')).toBe(false)
  })

  it('marks the server as failed and drops its tools when the process dies', async () => {
    const { ctx } = await setup({ approval: true })
    await ctx.mcp.connect(definition())

    const requested = nextRequest(ctx)
    const pending = ctx.tools.invoke('mcp__fixture__crash', {})
    const request = await requested
    ctx.approval.resolve(request.id, 'allow')

    const result = await pending
    expect(result.isError).toBe(true)
    await waitFor(() => ctx.mcp.get('fixture')?.status === 'error')
    expect(ctx.tools.has('mcp__fixture__echo')).toBe(false)
  })
})
