import { Service, type Context } from '@ruobai/cordis'

/**
 * A denial as reported back to the model.
 *
 * Neutral shape: the shell layer must not depend on the sandbox packages, so
 * the sandbox denial service produces values assignable to this interface.
 */
export interface ShellDenial {
  kind: string
  target?: string
  /** Guard id when the denial could be attributed to one. */
  guard?: string
  evidence: string
  confidence: string
  fingerprint: string
  repeated: number
  message?: string
}

/** Everything an executor needs; independent of tools and of the platform. */
export interface ShellRunSpec {
  command: string
  /** Absolute working directory. */
  cwd: string
  /** Absolute workspace root; the sandbox grants writes here. */
  root: string
  timeoutMs: number
  maxOutputBytes: number
  sessionId?: string
  signal?: AbortSignal
  /** Attempt counter, 1 for the first run. Escalation bumps it. */
  attempt?: number
  /**
   * False asks for execution outside the sandbox (approved by the tool layer
   * first). The executor decides whether that is allowed; it is not an
   * executor name.
   */
  sandbox?: boolean
}

/**
 * Credentials the harness itself may hold. Stripped from every child
 * environment so a command cannot exfiltrate them, sandboxed or not.
 */
export const SECRET_ENV = [
  'RBU_TOKEN',
  'RBU_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]

export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of SECRET_ENV) delete env[key]
  return env
}

export interface ShellRunResult {
  /** Rendered, model-facing output (exit code, stdout, stderr, denials). */
  content: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  truncated: boolean
  denials: ShellDenial[]
  /** Id of the executor that ran the command. */
  executor: string
  /** Exemption ids applied to this run, when it was retried after escalation. */
  relaxed?: string[]
  /** Set when the command ran under OS-level confinement. */
  sandboxed?: boolean
}

export interface ShellExecutor {
  id: string
  /** Whether the executor confines commands at the OS level. */
  sandboxed?: boolean
  run(spec: ShellRunSpec): Promise<ShellRunResult>
}

export interface ShellOutput {
  stdout: string
  stderr: string
  truncated: boolean
}

/**
 * Renders exit code, stdout and stderr into model-facing content. Shared by
 * every executor so sandboxed and direct runs look identical to the model.
 */
export function renderOutput(output: ShellOutput, exitCode: number | null, signal: NodeJS.Signals | null, durationMs: number) {
  const parts = [`exit code: ${exitCode ?? 'none'}${signal ? ` · signal ${signal}` : ''} · ${durationMs}ms`]
  if (output.stdout) parts.push(`--- stdout ---\n${output.stdout.trimEnd()}`)
  if (output.stderr) parts.push(`--- stderr ---\n${output.stderr.trimEnd()}`)
  if (!output.stdout && !output.stderr) parts.push('(no output)')
  if (output.truncated) parts.push('… output truncated')
  return parts.join('\n')
}

export class ShellUnavailableError extends Error {
  constructor(message = 'no shell executor is registered') {
    super(message)
    this.name = 'ShellUnavailableError'
  }
}

declare module '@ruobai/cordis' {
  interface Context {
    shell: ShellService
  }

  interface Events {
    'shell/before'(spec: ShellRunSpec): void
    'shell/after'(spec: ShellRunSpec, result: ShellRunResult): void
  }
}

/**
 * Holds the executor registry. `tool-bash` only knows this service, so
 * swapping "direct" for "sandboxed" is a `cordis.yml` edit, not a code change.
 */
export class ShellService extends Service {
  private readonly executors = new Map<string, ShellExecutor>()
  private defaultId: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'shell')
    ctx.effect(() => () => {
      this.executors.clear()
      this.defaultId = undefined
    }, 'shell.dispose')
  }

  /**
   * Register an executor. Returns a disposer; callers hand it to
   * `ctx.effect()` so "executor alive" and "plugin alive" coincide.
   */
  register(executor: ShellExecutor, options: { default?: boolean } = {}): () => void {
    if (this.executors.has(executor.id)) {
      throw new Error(`shell executor "${executor.id}" is already registered`)
    }
    this.executors.set(executor.id, executor)
    if (options.default || !this.defaultId) this.defaultId = executor.id
    return () => {
      if (this.executors.get(executor.id) !== executor) return
      this.executors.delete(executor.id)
      if (this.defaultId === executor.id) {
        this.defaultId = this.executors.keys().next().value
      }
    }
  }

  executor(id?: string): ShellExecutor | undefined {
    return this.executors.get(id ?? this.defaultId ?? '')
  }

  ids(): string[] {
    return [...this.executors.keys()]
  }

  /** Runs through the requested executor, or the default one. */
  async run(spec: ShellRunSpec, executorId?: string): Promise<ShellRunResult> {
    const executor = this.executor(executorId)
    if (!executor) {
      // Fail closed: never silently fall back to an unconfined spawn.
      throw new ShellUnavailableError(
        `no shell executor "${executorId ?? 'default'}" is registered (available: ${this.ids().join(', ') || 'none'})`,
      )
    }
    this.ctx.emit('shell/before', spec)
    const result = await executor.run(spec)
    this.ctx.emit('shell/after', spec, result)
    return result
  }
}

export default ShellService

export const meta = {
  title: 'Shell 执行面',
  description: '命令执行器注册表；沙箱与直连都是它的实现。',
}
