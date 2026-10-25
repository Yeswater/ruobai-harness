import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ApprovalService from '@ruobai/approval'
import { Context } from '@ruobai/cordis'
import ShellService from '@ruobai/shell'
import DirectShell from '@ruobai/shell-direct'
import ToolRegistry from '@ruobai/tools'
import BashTools from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('bash per-session workspace', () => {
  it('runs in the run workspace and rejects a cwd outside it', async () => {
    const fallback = await mkdtemp(join(tmpdir(), 'rbh-bash-root-'))
    const workspace = await mkdtemp(join(tmpdir(), 'rbh-bash-ws-'))
    cleanups.push(
      () => rm(fallback, { recursive: true, force: true }),
      () => rm(workspace, { recursive: true, force: true }),
    )

    const ctx = new Context()
    const tools = ctx.plugin(ToolRegistry)
    await tools
    const approval = ctx.plugin(ApprovalService)
    await approval
    const shell = ctx.plugin(ShellService)
    await shell
    const direct = ctx.plugin(DirectShell, { shell: '/bin/sh' })
    await direct
    const bash = ctx.plugin(BashTools, { root: fallback, timeoutMs: 2_000 })
    await bash
    cleanups.push(() => bash.dispose(), () => direct.dispose(), () => shell.dispose(), () => approval.dispose(), () => tools.dispose())
    ctx.on('approval/requested', (request: any) => ctx.approval.resolve(request.id, 'allow'))

    const pwd = await ctx.tools.invoke('bash', { command: 'pwd' }, { sessionId: 's1', workspace })
    expect(pwd.isError).toBe(false)
    expect(pwd.content).toContain(workspace)

    const escape = await ctx.tools.invoke(
      'bash',
      { command: 'pwd', cwd: '..' },
      { sessionId: 's1', workspace },
    )
    expect(escape.isError).toBe(true)
    expect(escape.content).toContain('cwd escapes the workspace')
  })
})
