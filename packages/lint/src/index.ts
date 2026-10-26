import { isAbsolute, join } from 'node:path'
import { type Context, Service } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type {} from '@ruobai/shell'
import { loadBaseline, partitionDiagnostics } from './baseline.ts'
import { normalizePath } from './fingerprint.ts'
import { parseBiome, parsePlain, parseTsc, sectionOf } from './parsers.ts'
import type {
  CheckerConfig,
  CheckerReport,
  CheckInput,
  CheckResult,
  Diagnostic,
  Partition,
} from './types.ts'

export {
  BASELINE_VERSION,
  baselineOf,
  loadBaseline,
  partitionDiagnostics,
} from './baseline.ts'
export {
  fingerprintOf,
  normalizeMessage,
  normalizePath,
} from './fingerprint.ts'
export { parseBiome, parsePlain, parseTsc, sectionOf } from './parsers.ts'
export type * from './types.ts'

export interface Config {
  /** Baseline file, relative to the workspace root. */
  baseline?: string
  checkers?: CheckerConfig[]
  editTimeoutMs?: number
  stopTimeoutMs?: number
}

declare module '@ruobai/cordis' {
  interface Context {
    lint: LintService
  }

  interface Events {
    'lint/run'(result: CheckResult & { scope: CheckInput['scope'] }): void
  }
}

/** Default checkers; commands come from configuration, never from the model. */
export const DEFAULT_CHECKERS: CheckerConfig[] = [
  {
    id: 'biome-format',
    scope: 'edit',
    command: 'node_modules/.bin/biome check --write',
    parser: 'plain',
    writes: true,
    enabled: false,
  },
  {
    id: 'biome-lint',
    scope: 'edit',
    command: 'node_modules/.bin/biome check --reporter=json',
    parser: 'biome',
    enabled: false,
  },
  {
    id: 'biome-stop',
    scope: 'stop',
    command: 'node_modules/.bin/biome check --reporter=json',
    parser: 'biome',
    enabled: false,
  },
  {
    id: 'tsc',
    scope: 'stop',
    command: 'node_modules/.bin/tsc -p tsconfig.json --pretty false',
    parser: 'tsc',
    enabled: false,
  },
]

function quoteArgument(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Runs configured checkers through the shell executor, so timeouts, output
 * caps and environment scrubbing stay in one place. Parsing is tolerant: a
 * checker that crashes reports an error instead of inventing diagnostics.
 */
export class LintService extends Service {
  static inject = ['shell']

  static Config: z<Config> = z.object({
    baseline: z.string().default('.ruobai/lint-baseline.json'),
    checkers: z.array(z.any()).default([]),
    editTimeoutMs: z.number().min(100).default(4000),
    stopTimeoutMs: z.number().min(1000).default(120_000),
  })

  private readonly checkers = new Map<string, CheckerConfig>()

  constructor(
    ctx: Context,
    public config: Config,
  ) {
    super(ctx, 'lint')
    for (const checker of [...DEFAULT_CHECKERS, ...(config.checkers ?? [])])
      this.register(checker)
  }

  register(checker: CheckerConfig) {
    const key = `${checker.scope}:${checker.id}`
    this.checkers.set(key, checker)
    return () => {
      if (this.checkers.get(key) === checker) this.checkers.delete(key)
    }
  }

  list(): CheckerConfig[] {
    return [...this.checkers.values()]
  }

  baselinePath(root: string) {
    const configured = this.config.baseline ?? '.ruobai/lint-baseline.json'
    return isAbsolute(configured) ? configured : join(root, configured)
  }

  async partition(diagnostics: Diagnostic[], root: string): Promise<Partition> {
    return partitionDiagnostics(
      diagnostics,
      await loadBaseline(this.baselinePath(root)),
    )
  }

  async run(input: CheckInput): Promise<CheckResult> {
    const startedAt = Date.now()
    const configured = [...this.checkers.values()].filter(
      (checker) => checker.scope === input.scope && checker.enabled !== false,
    )
    // Formatters rewrite files; they must settle before the read-only checks.
    const writers = configured.filter((checker) => checker.writes)
    const readers = configured.filter((checker) => !checker.writes)

    const diagnostics: Diagnostic[] = []
    const reports: CheckerReport[] = []

    const execute = async (checker: CheckerConfig) => {
      const report = await this.executeOne(checker, input)
      reports.push(report.report)
      diagnostics.push(...report.diagnostics)
    }

    for (const checker of writers) await execute(checker)
    await Promise.all(readers.map(execute))

    const seen = new Set<string>()
    const unique = diagnostics.filter((item) => {
      if (seen.has(item.fingerprint)) return false
      seen.add(item.fingerprint)
      return true
    })

    const result: CheckResult = {
      diagnostics: unique,
      checkers: reports,
      durationMs: Date.now() - startedAt,
    }
    this.ctx.emit('lint/run', { ...result, scope: input.scope })
    return result
  }

  private async executeOne(checker: CheckerConfig, input: CheckInput) {
    const files =
      input.scope === 'edit' && input.files?.length
        ? [
            ...new Set(
              input.files.map((file) => normalizePath(file, input.root)),
            ),
          ]
        : undefined
    const command = files?.length
      ? `${checker.command} ${files.map(quoteArgument).join(' ')}`
      : checker.command
    const timeoutMs =
      checker.timeoutMs ??
      (input.scope === 'edit'
        ? (this.config.editTimeoutMs ?? 4000)
        : (this.config.stopTimeoutMs ?? 120_000))

    const report: CheckerReport = {
      id: checker.id,
      exitCode: null,
      durationMs: 0,
    }
    const startedAt = Date.now()
    try {
      const result = await this.ctx.shell.run(
        {
          command,
          cwd: input.cwd,
          root: input.root,
          timeoutMs,
          maxOutputBytes: 512 * 1024,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        },
        checker.executor,
      )
      report.exitCode = result.exitCode
      report.durationMs = Date.now() - startedAt
      const stdout = sectionOf(result.content, 'stdout')
      const stderr = sectionOf(result.content, 'stderr')
      const parser = checker.parser ?? 'plain'
      // A formatter's output is a summary, not a defect list.
      const diagnostics = checker.writes
        ? []
        : parser === 'biome'
          ? parseBiome(stdout || stderr, input.root)
          : parser === 'tsc'
            ? parseTsc(`${stdout}\n${stderr}`, input.root)
            : result.exitCode === 0
              ? []
              : parsePlain(stderr || stdout, input.root, checker.id)

      if (
        !checker.writes &&
        !diagnostics.length &&
        result.exitCode !== 0 &&
        stderr.trim()
      ) {
        report.error = stderr.trim().slice(0, 500)
      }
      if (checker.writes && result.exitCode !== 0 && stderr.trim()) {
        report.error = stderr.trim().slice(0, 500)
      }
      return { report, diagnostics }
    } catch (error) {
      report.durationMs = Date.now() - startedAt
      report.error = error instanceof Error ? error.message : String(error)
      return { report, diagnostics: [] as Diagnostic[] }
    }
  }
}

export default LintService

export const meta = {
  title: 'Lint 检查',
  description: '执行配置的检查命令并归一化为诊断。',
}
