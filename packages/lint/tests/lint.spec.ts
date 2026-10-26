import { Context } from '@ruobai/cordis'
import ShellService, {
  type ShellRunResult,
  type ShellRunSpec,
} from '@ruobai/shell'
import { afterEach, describe, expect, it } from 'vitest'
import { partitionDiagnostics } from '../src/baseline.ts'
import { fingerprintOf, normalizeMessage } from '../src/fingerprint.ts'
import LintService from '../src/index.ts'
import { parseBiome, parseTsc, sectionOf } from '../src/parsers.ts'
import type { Diagnostic } from '../src/types.ts'

const cleanups: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!.dispose()
})

const BIOME_JSON = JSON.stringify({
  diagnostics: [
    {
      category: 'lint/style/useConst',
      severity: 'error',
      message: 'This let declares a variable that is never reassigned.',
      location: {
        path: '/repo/src/a.ts',
        start: { line: 2, column: 1 },
        end: { line: 2, column: 4 },
      },
    },
    {
      category: 'lint/suspicious/noDoubleEquals',
      severity: 'warning',
      message: 'Use === instead of ==.',
      location: { path: '/repo/src/b.ts', start: { line: 1, column: 1 } },
    },
  ],
})

/** Biome 1.x reported a byte span plus the source instead of a start position. */
const LEGACY_BIOME_JSON = JSON.stringify({
  diagnostics: [
    {
      category: 'lint/style/useConst',
      severity: 'error',
      description: 'This let declares a variable that is never reassigned.',
      location: {
        path: { file: '/repo/src/a.ts' },
        span: [10, 14],
        sourceCode: 'let x = 1\nlet y = 2\n',
      },
    },
  ],
})

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  const path = overrides.path ?? 'src/a.ts'
  const rule = overrides.rule ?? 'rule'
  const message = overrides.message ?? 'problem'
  return {
    path,
    rule,
    level: 'error',
    message,
    fingerprint: fingerprintOf(rule, path, message),
    ...overrides,
  }
}

function fakeExecutor(
  content: string | (() => string),
  exitCode = 0,
  id = 'fake',
) {
  const specs: ShellRunSpec[] = []
  return {
    specs,
    executor: {
      id,
      async run(spec: ShellRunSpec): Promise<ShellRunResult> {
        specs.push(spec)
        return {
          content: typeof content === 'function' ? content() : content,
          exitCode,
          signal: null,
          durationMs: 1,
          truncated: false,
          denials: [],
          executor: id,
        }
      },
    },
  }
}

describe('fingerprints and baselines', () => {
  it('normalizes whitespace and ANSI before hashing', () => {
    expect(normalizeMessage('  a\t b\n')).toBe('a b')
    expect(normalizeMessage('\u001b[31ma b\u001b[0m')).toBe('a b')
    expect(fingerprintOf('r', 'a.ts', ' a  b ')).toBe(
      fingerprintOf('r', 'a.ts', 'a b'),
    )
    expect(fingerprintOf('r', 'a.ts', 'a b')).not.toBe(
      fingerprintOf('r', 'b.ts', 'a b'),
    )
  })

  it('only blocks new errors and warnings promoted to errors', () => {
    const known = diagnostic({ level: 'error', message: 'old' })
    const upgraded = diagnostic({ level: 'error', message: 'was a warning' })
    const fresh = diagnostic({ level: 'error', message: 'new' })
    const warn = diagnostic({ level: 'warn', message: 'new warning' })
    const partition = partitionDiagnostics([known, upgraded, fresh, warn], {
      version: 1,
      entries: [
        { ...known, fingerprint: known.fingerprint },
        { ...upgraded, fingerprint: upgraded.fingerprint, level: 'warn' },
      ],
    })
    expect(partition.fresh.map((item) => item.message)).toEqual([
      'new',
      'new warning',
    ])
    expect(partition.worsened.map((item) => item.message)).toEqual([
      'was a warning',
    ])
    expect(partition.known.map((item) => item.message)).toEqual(['old'])
    expect(partition.blocking.map((item) => item.message)).toEqual([
      'was a warning',
      'new',
    ])
  })
})

describe('parsers', () => {
  it('parses Biome JSON into located diagnostics', () => {
    const diagnostics = parseBiome(BIOME_JSON, '/repo')
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]).toMatchObject({
      path: 'src/a.ts',
      line: 2,
      column: 1,
      rule: 'lint/style/useConst',
      level: 'error',
      message: 'This let declares a variable that is never reassigned.',
    })
    expect(diagnostics[1]).toMatchObject({
      path: 'src/b.ts',
      rule: 'lint/suspicious/noDoubleEquals',
      level: 'warn',
      message: 'Use === instead of ==.',
    })
  })

  it('still reads the legacy span-based shape', () => {
    const diagnostics = parseBiome(LEGACY_BIOME_JSON, '/repo')
    expect(diagnostics[0]).toMatchObject({
      path: 'src/a.ts',
      line: 2,
      column: 1,
      message: 'This let declares a variable that is never reassigned.',
    })
  })

  it('parses tsc lines and tolerates malformed output', () => {
    const diagnostics = parseTsc(
      "src/a.ts(12,5): error TS2322: Type 'string' is not assignable.\nnoise\n",
      '/repo',
    )
    expect(diagnostics).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        line: 12,
        column: 5,
        rule: 'TS2322',
      }),
    ])
    expect(parseBiome('not json', '/repo')).toEqual([])
  })

  it('splits the shell renderer into streams', () => {
    const content =
      'exit code: 1 · 2ms\n--- stdout ---\n{"a":1}\n--- stderr ---\nboom'
    expect(sectionOf(content, 'stdout')).toBe('{"a":1}')
    expect(sectionOf(content, 'stderr')).toBe('boom')
  })
})

describe('lint service', () => {
  it('runs the configured checker with the changed files and parses its output', async () => {
    const ctx = new Context()
    const shell = ctx.plugin(ShellService)
    await shell
    cleanups.push(shell)
    const fake = fakeExecutor(
      `exit code: 0 · 1ms\n--- stdout ---\n${BIOME_JSON}`,
    )
    ctx.shell.register(fake.executor)
    const lint = ctx.plugin(LintService, {
      checkers: [
        { id: 'biome', scope: 'edit', command: 'biome check', parser: 'biome' },
      ],
    })
    await lint
    cleanups.push(lint)

    const result = await ctx.lint.run({
      scope: 'edit',
      files: ['src/a.ts'],
      cwd: '/repo',
      root: '/repo',
    })
    expect(fake.specs[0]?.command).toBe("biome check 'src/a.ts'")
    expect(result.diagnostics).toHaveLength(2)
    expect(result.checkers[0]).toMatchObject({ id: 'biome', exitCode: 0 })
  })

  it('reports a checker error instead of inventing diagnostics', async () => {
    const ctx = new Context()
    const shell = ctx.plugin(ShellService)
    await shell
    cleanups.push(shell)
    const fake = fakeExecutor(
      'exit code: 127 · 1ms\n--- stderr ---\nbiome: not found',
      127,
    )
    ctx.shell.register(fake.executor)
    const lint = ctx.plugin(LintService, {
      checkers: [
        { id: 'biome', scope: 'stop', command: 'biome check', parser: 'biome' },
      ],
    })
    await lint
    cleanups.push(lint)

    const result = await ctx.lint.run({
      scope: 'stop',
      cwd: '/repo',
      root: '/repo',
    })
    expect(result.diagnostics).toEqual([])
    expect(result.checkers[0]?.error).toContain('not found')
  })

  it('reads tsc diagnostics from stdout when stderr only has the runner banner', async () => {
    const ctx = new Context()
    const shell = ctx.plugin(ShellService)
    await shell
    cleanups.push(shell)
    const fake = fakeExecutor(
      'exit code: 2 · 1ms\n--- stdout ---\npackages/a.ts(3,7): error TS2322: bad type\n--- stderr ---\n$ tsc -p tsconfig.json',
      2,
    )
    ctx.shell.register(fake.executor)
    const lint = ctx.plugin(LintService, {
      checkers: [{ id: 'tsc', scope: 'stop', command: 'tsc', parser: 'tsc' }],
    })
    await lint
    cleanups.push(lint)

    const result = await ctx.lint.run({
      scope: 'stop',
      cwd: '/repo',
      root: '/repo',
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        path: 'packages/a.ts',
        line: 3,
        column: 7,
        rule: 'TS2322',
        level: 'error',
      }),
    ])
  })

  it('runs harness checks through the configured executor', async () => {
    const ctx = new Context()
    const shell = ctx.plugin(ShellService)
    await shell
    cleanups.push(shell)
    const payload = JSON.stringify({ diagnostics: [] })
    const host = fakeExecutor(payload, 0, 'host')
    const sandbox = fakeExecutor(payload, 0, 'sandbox')
    ctx.shell.register(host.executor)
    ctx.shell.register(sandbox.executor, { default: true })
    const lint = ctx.plugin(LintService, {
      checkers: [
        {
          id: 'host-check',
          scope: 'stop',
          command: 'check',
          parser: 'biome',
          executor: 'host',
        },
      ],
    })
    await lint
    cleanups.push(lint)

    await ctx.lint.run({ scope: 'stop', cwd: '/repo', root: '/repo' })
    expect(host.specs).toHaveLength(1)
    expect(sandbox.specs).toHaveLength(0)
  })
})
