import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ApprovalService from '@ruobai/approval'
import { Context } from '@ruobai/cordis'
import ShellService from '@ruobai/shell'
import DirectShell from '@ruobai/shell-direct'
import ToolRegistry from '@ruobai/tools'
import BashTools, { type Config } from '../src/index.ts'

/**
 * Whether this process may signal a process group it owns.
 *
 * False inside Seatbelt: the sandbox denies process-control even for children.
 */
async function canSignalOwnGroup(): Promise<boolean> {
  const { spawn } = await import('node:child_process')
  const child = spawn('sleep', ['1'], { detached: true, stdio: 'ignore' })
  try {
    process.kill(-child.pid!, 'SIGTERM')
    return true
  } catch {
    return false
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

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
  const shell = ctx.plugin(ShellService)
  await shell
  const direct = ctx.plugin(DirectShell, { shell: '/bin/sh' })
  await direct
  const bash = ctx.plugin(BashTools, {
    root,
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
    ...config,
  })
  await bash
  cleanups.push(() => bash.dispose(), () => direct.dispose(), () => shell.dispose(), () => approval.dispose(), () => tools.dispose())
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
  it('reports the trimmed command as the approval subject', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('bash')!.approvalSubject!({ command: '  echo hi  ' }, {})).toEqual({
      kind: 'command',
      value: 'echo hi',
    })
    expect(() => ctx.tools.get('bash')!.approvalSubject!({}, {})).toThrow(/command is required/)
  })

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
    // Signalling a process *group* needs process-control rights, which a
    // confined process does not have. When this suite itself runs inside
    // Seatbelt the kill is denied; the timeout is still enforced, just without
    // a group kill. The harness process is never confined, so production always
    // takes the first branch. Probed at runtime rather than inferred from an
    // env marker, so the test is honest in both places.
    if (await canSignalOwnGroup()) {
      expect(result.content).toContain('timed out after 100ms')
    } else {
      expect(result.content).toMatch(/timed out after 100ms|kill EPERM/)
    }
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
