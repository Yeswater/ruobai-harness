import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ApprovalService from '@ruobai/approval'
import { Context } from '@ruobai/cordis'
import ToolRegistry from '@ruobai/tools'
import BashTools, { type Config } from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup(config: Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rbh-bash-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  const ctx = new Context()
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const approval = ctx.plugin(ApprovalService)
  await approval
  const bash = ctx.plugin(BashTools, {
    root,
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
    ...config,
  })
  await bash
  cleanups.push(() => bash.dispose(), () => approval.dispose(), () => tools.dispose())
  return { ctx, root }
}

function nextRequest(ctx: Context) {
  return new Promise<any>((resolve) => {
    ctx.once('approval/requested', resolve)
  })
}

async function call(ctx: Context, args: unknown, decision: 'allow' | 'deny' = 'allow') {
  const requested = nextRequest(ctx)
  const pending = ctx.tools.invoke('bash', args)
  const request = await requested
  ctx.approval.resolve(request.id, decision)
  return { request, result: await pending }
}

describe('bash tool', () => {
  it('asks for approval, runs in the workspace and reports the exit code', async () => {
    const { ctx, root } = await setup()
    const { request, result } = await call(ctx, { command: 'printf hello && pwd' })

    expect(request.tool).toBe('bash')
    expect(request.summary).toContain('printf hello')
    expect(request.diff).toContain('$ printf hello')
    expect(result.isError).toBe(false)
    expect(result.content).toContain('hello')
    expect(result.content).toContain(root)
    expect(result.content).toContain('exit code: 0')
  })

  it('returns non-zero exits to the model instead of failing the call', async () => {
    const { ctx } = await setup()
    const { result } = await call(ctx, { command: 'printf oops >&2; exit 3' })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('exit code: 3')
    expect(result.content).toContain('oops')
    expect(result.content).toContain('--- stderr ---')
  })

  it('kills a command that exceeds its timeout', async () => {
    const { ctx } = await setup()
    const { result } = await call(ctx, { command: 'sleep 5', timeoutMs: 100 })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out after 100ms')
  })

  it('truncates large output', async () => {
    const { ctx } = await setup()
    const { result } = await call(ctx, { command: 'yes x | head -c 5000' })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('output truncated')
    expect(result.content.length).toBeLessThan(2_000)
  })

  it('rejects a working directory outside the workspace', async () => {
    const { ctx } = await setup()
    const { result } = await call(ctx, { command: 'pwd', cwd: '..' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('escapes the workspace')
  })

  it('strips harness credentials from the child environment', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-do-not-leak'
    cleanups.push(() => { delete process.env.DEEPSEEK_API_KEY })

    const { ctx } = await setup()
    const { result } = await call(ctx, { command: 'printf %s "${DEEPSEEK_API_KEY-unset}"' })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('unset')
    expect(result.content).not.toContain('sk-do-not-leak')
  })

  it('denies execution without spawning anything', async () => {
    const { ctx, root } = await setup()
    const { result } = await call(ctx, { command: `touch ${root}/denied` }, 'deny')

    expect(result.isError).toBe(true)
    expect(result.content).toContain('denied')
  })
})
