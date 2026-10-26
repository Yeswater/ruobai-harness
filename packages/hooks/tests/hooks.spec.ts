import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@ruobai/cordis'
import LintService from '@ruobai/lint'
import LlmService from '@ruobai/llm'
import SessionService from '@ruobai/session'
import SettingsService from '@ruobai/settings'
import ShellService, {
  type ShellRunResult,
  type ShellRunSpec,
} from '@ruobai/shell'
import { afterEach, describe, expect, it } from 'vitest'
import HooksService from '../src/index.ts'

const cleanups: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!.dispose()
})

function biomeOutput(): string {
  return JSON.stringify({
    diagnostics: [
      {
        category: 'lint/style/useConst',
        severity: 'error',
        description: 'This let declares a variable that is never reassigned.',
        location: {
          path: { file: `${process.cwd()}/src/a.ts` },
          span: [0, 3],
          sourceCode: 'let x = 1\n',
        },
      },
    ],
  })
}

function cleanOutput(): string {
  return JSON.stringify({ diagnostics: [] })
}

async function mount() {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(sessions)
  const shell = ctx.plugin(ShellService)
  await shell
  cleanups.push(shell)

  let output = biomeOutput()
  const specs: ShellRunSpec[] = []
  ctx.shell.register({
    id: 'fake',
    async run(spec: ShellRunSpec): Promise<ShellRunResult> {
      specs.push(spec)
      return {
        content: `exit code: 0 · 1ms\n--- stdout ---\n${output}`,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        truncated: false,
        denials: [],
        executor: 'fake',
      }
    },
  })

  const lint = ctx.plugin(LintService, {
    checkers: [
      { id: 'biome', scope: 'edit', command: 'biome check', parser: 'biome' },
      { id: 'biome', scope: 'stop', command: 'biome check', parser: 'biome' },
    ],
  })
  await lint
  cleanups.push(lint)
  const hooks = ctx.plugin(HooksService)
  await hooks
  cleanups.push(hooks)

  return {
    ctx,
    specs,
    setOutput(next: string) {
      output = next
    },
    session: ctx.sessions.create({ title: 'gate' }),
  }
}

describe('guard', () => {
  it('denies protected writes and bypass commands, but allows reading config', async () => {
    const { ctx, session } = await mount()
    const denied = ctx.hooks.guard({
      name: 'write_file',
      args: { path: '.claude/settings.json', content: '{}' },
      sessionId: session.id,
    })
    expect(denied?.deny).toBe(true)
    expect(denied?.reason).toContain('受保护路径')

    expect(
      ctx.hooks.guard({
        name: 'write_file',
        args: { path: 'packages/a/src/index.ts', content: '' },
        sessionId: session.id,
      }),
    ).toBeUndefined()

    expect(
      ctx.hooks.guard({
        name: 'bash',
        args: { command: 'git commit --no-verify -m wip' },
        sessionId: session.id,
      })?.deny,
    ).toBe(true)

    expect(
      ctx.hooks.guard({
        name: 'bash',
        args: { command: 'cat tsconfig.json' },
        sessionId: session.id,
      }),
    ).toBeUndefined()

    expect(
      ctx.hooks.guard({
        name: 'bash',
        args: { command: 'echo "{}" > .claude/settings.json' },
        sessionId: session.id,
      })?.deny,
    ).toBe(true)
  })

  it('records a violation event for the session', async () => {
    const { ctx, session } = await mount()
    ctx.hooks.guard({
      name: 'write_file',
      args: { path: 'biome.json' },
      sessionId: session.id,
    })
    const events = ctx.sessions.get(session.id)!.events
    expect(events.some((event) => event.type === 'hooks/violation')).toBe(true)
    expect(ctx.hooks.status().metrics.violations).toBe(1)
  })
})

describe('edit gate', () => {
  it('feeds back only new diagnostics after a write', async () => {
    const { ctx, session } = await mount()
    const result = await ctx.hooks.afterTool(
      { name: 'write_file', args: { path: 'src/a.ts' }, sessionId: session.id },
      { isError: false },
    )
    expect(result.feedback).toContain('<hook-diagnostics')
    expect(result.feedback).toContain('lint/style/useConst')
    expect(ctx.hooks.status().lastRun?.layer).toBe('edit')
  })

  it('stays silent when the change is clean', async () => {
    const { ctx, session, setOutput } = await mount()
    setOutput(cleanOutput())
    const result = await ctx.hooks.afterTool(
      { name: 'edit_file', args: { path: 'src/a.ts' }, sessionId: session.id },
      { isError: false },
    )
    expect(result.feedback).toBeUndefined()
    expect(result.diagnostics).toEqual([])
  })
})

describe('stop gate', () => {
  it('blocks once, then escalates when the diagnostics do not change', async () => {
    const { ctx, session } = await mount()
    const first = await ctx.hooks.beforeStop(session.id)
    expect(first.blocked).toBe(true)
    expect(first.feedback).toContain('round="1"')

    const second = await ctx.hooks.beforeStop(session.id)
    expect(second.blocked).toBe(false)
    expect(second.escalated).toBe(true)

    const status = ctx.hooks.status()
    expect(status.metrics.blocks).toBe(1)
    expect(status.metrics.escalations).toBe(1)
    expect(
      ctx.sessions
        .get(session.id)!
        .events.some((event) => event.type === 'hooks/escalated'),
    ).toBe(true)
  })

  it('passes after the problem is fixed and resets on a new user turn', async () => {
    const { ctx, session, setOutput } = await mount()
    expect((await ctx.hooks.beforeStop(session.id)).blocked).toBe(true)
    // A new user turn resets the round counter, so the same defect blocks again.
    ctx.sessions.append(session.id, 'message/user', {
      id: 'u2',
      text: 'try again',
      at: 2,
    })
    setOutput(cleanOutput())
    const passed = await ctx.hooks.beforeStop(session.id)
    expect(passed.blocked).toBe(false)
    expect(passed.escalated).toBeUndefined()
    expect(ctx.hooks.status().metrics.passes).toBe(1)
  })
})

describe('audit', () => {
  it('uses the configured provider and records findings without blocking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbh-audit-'))
    cleanups.push({
      dispose: async () => {
        await rm(dir, { recursive: true, force: true })
      },
    })
    const settingsPath = join(dir, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({
        llm: {
          activeProvider: 'fake',
          activeModel: 'fake-1',
          providers: [
            {
              id: 'fake',
              name: 'Fake',
              baseUrl: 'https://example.com/v1',
              mode: 'direct',
              models: [{ id: 'fake-1' }],
            },
          ],
        },
      }),
    )

    const ctx = new Context()
    const sessions = ctx.plugin(SessionService)
    await sessions
    cleanups.push(sessions)
    const settings = ctx.plugin(SettingsService, { path: settingsPath })
    await settings
    cleanups.push(settings)
    const llm = ctx.plugin(LlmService, { provider: 'fake', model: 'fake-1' })
    await llm
    cleanups.push(llm)
    ctx.llm.register({
      name: 'fake',
      models: ['fake-1'],
      async *stream() {
        yield {
          type: 'text-delta' as const,
          text: '{"findings":[{"path":"src/a.ts","line":3,"rule":"weak-test","level":"warn","message":"missing assertions"}]}',
        }
        yield { type: 'done' as const, reason: 'stop' as const }
      },
    })
    const hooks = ctx.plugin(HooksService)
    await hooks
    cleanups.push(hooks)
    await ctx.settings.updateHooks({
      audit: { enabled: true, trigger: 'manual' },
    })

    const session = ctx.sessions.create()
    const findings = await ctx.hooks.audit(session.id, 'manual')
    expect(findings).toEqual([
      {
        path: 'src/a.ts',
        line: 3,
        rule: 'weak-test',
        level: 'warn',
        message: 'missing assertions',
      },
    ])
    expect(
      ctx.sessions
        .get(session.id)!
        .events.some((event) => event.type === 'hooks/audit'),
    ).toBe(true)
  })
})
