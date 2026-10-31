import { spawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@ruobai/cordis'
import type { NetService } from '@ruobai/net'
import type {} from '@ruobai/net'
import z from '@ruobai/schemastery'
import { SECRET_ENV, scrubbedEnv, type ShellRunSpec, type ShellRunResult } from '@ruobai/shell'

export interface Config {
  /** Shell binary used to interpret the command. */
  shell?: string
  /** Register as the default executor. */
  default?: boolean
}

export { SECRET_ENV, scrubbedEnv }

export function shellArgs(command: string, platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
}

/** Kill the whole process group so pipes and grandchildren die with the shell. */
export function killGroup(child: ChildProcess, graceMs = 500) {
  const pid = child.pid
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (pid) process.kill(-pid, signal)
      else child.kill(signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    }
  }
  signalGroup('SIGTERM')
  const hard = setTimeout(() => signalGroup('SIGKILL'), graceMs)
  if (typeof hard.unref === 'function') hard.unref()
  child.once('close', () => clearTimeout(hard))
}

export interface Captured {
  stdout: Buffer[]
  stderr: Buffer[]
  sizes: { stdout: number; stderr: number }
  truncated: { stdout: boolean; stderr: boolean }
}

export function capture(): Captured {
  return {
    stdout: [],
    stderr: [],
    sizes: { stdout: 0, stderr: 0 },
    truncated: { stdout: false, stderr: false },
  }
}

export function collect(captured: Captured, stream: 'stdout' | 'stderr', data: Buffer, maxOutputBytes: number) {
  const remaining = maxOutputBytes - captured.sizes[stream]
  if (remaining <= 0) {
    captured.truncated[stream] = true
    return
  }
  const slice = data.length > remaining ? data.subarray(0, remaining) : data
  captured[stream].push(slice)
  captured.sizes[stream] += slice.length
  if (slice.length < data.length) captured.truncated[stream] = true
}

/** Renders exit code, stdout and stderr into the model-facing content. */
export function render(
  captured: Captured,
  code: number | null,
  signal: NodeJS.Signals | null,
  durationMs: number,
) {
  const stdout = Buffer.concat(captured.stdout).toString('utf8')
  const stderr = Buffer.concat(captured.stderr).toString('utf8')
  const parts = [`exit code: ${code ?? 'none'}${signal ? ` · signal ${signal}` : ''} · ${durationMs}ms`]
  if (stdout) parts.push(`--- stdout ---\n${stdout.trimEnd()}`)
  if (stderr) parts.push(`--- stderr ---\n${stderr.trimEnd()}`)
  if (!stdout && !stderr) parts.push('(no output)')
  if (captured.truncated.stdout || captured.truncated.stderr) parts.push('… output truncated')
  return parts.join('\n')
}

interface SpawnOptions {
  cwd: string
  shell: string
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export interface SpawnOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  captured: Captured
  failure?: Error
}

/**
 * Spawns the shell, enforces timeout, kills the process group on abort and
 * resolves with the captured output. Also used by the macOS sandbox provider,
 * which supplies its own `spawn` wrapper (profile on fd 3).
 */
export function spawnCaptured(
  command: string,
  options: SpawnOptions,
  spawnChild: (shellArgs: string[]) => ChildProcess = args => spawn(options.shell, args, {
    cwd: options.cwd,
    env: options.env ?? scrubbedEnv(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawnChild(shellArgs(command))
    const started = Date.now()
    const captured = capture()
    let settled = false
    let failure: Error | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let force: ReturnType<typeof setTimeout> | undefined

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (force) clearTimeout(force)
      options.signal?.removeEventListener('abort', abort)
      resolve({
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        captured,
        ...(failure ? { failure } : {}),
      })
    }

    const abort = () => {
      failure = new Error('command was cancelled')
      killGroup(child)
      force = setTimeout(() => settle(null, null), 500)
    }

    child.stdout?.on('data', (data: Buffer) => collect(captured, 'stdout', data, options.maxOutputBytes))
    child.stderr?.on('data', (data: Buffer) => collect(captured, 'stderr', data, options.maxOutputBytes))
    child.on('error', (error) => {
      failure = error
      settle(null, null)
    })
    child.on('close', (code, signal) => settle(code, signal))

    timer = setTimeout(() => {
      failure = new Error(`command timed out after ${options.timeoutMs}ms`)
      killGroup(child)
      force = setTimeout(() => settle(null, null), 500)
    }, options.timeoutMs)

    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Direct (unconfined) executor: the pre-sandbox behaviour, kept for opt-out. */
export function createDirectExecutor(
  shell: string,
  proxyEnv: () => Promise<Record<string, string>> = async () => ({}),
): {
  id: string
  sandboxed: false
  run(spec: ShellRunSpec): Promise<ShellRunResult>
} {
  return {
    id: 'direct',
    sandboxed: false,
    async run(spec: ShellRunSpec) {
      const outcome = await spawnCaptured(spec.command, {
        cwd: spec.cwd,
        shell,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        signal: spec.signal,
        env: { ...scrubbedEnv(), ...(await proxyEnv()) },
      })
      const content = render(outcome.captured, outcome.exitCode, outcome.signal, outcome.durationMs)
      if (outcome.failure) throw new Error(`${outcome.failure.message}\n\n${content}`)
      return {
        content,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: outcome.durationMs,
        truncated: outcome.captured.truncated.stdout || outcome.captured.truncated.stderr,
        denials: [],
        executor: 'direct',
        sandboxed: false,
      }
    },
  }
}

/**
 * Unconfined executor. Mounting it is an explicit opt-out: without it (and
 * without `shell-sandboxed`) `tool-bash` fails closed.
 */
export default class DirectShell {
  static inject = ['shell']

  static Config: z<Config> = z.object({
    shell: z.string().default(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
    default: z.boolean().default(true),
  })

  constructor(ctx: Context, config: Config) {
    const shell = config.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
    // Commands inherit the same proxy as the harness's own HTTP calls; local
    // hosts stay direct through NO_PROXY.
    const proxyEnv = async () => {
      const net = ctx.get('net', false) as NetService | undefined
      return net ? net.subprocessEnv() : {}
    }
    ctx.effect(
      () => ctx.shell.register(createDirectExecutor(shell, proxyEnv), { default: config.default !== false }),
      'shell.direct',
    )
  }
}

export const meta = {
  title: '直连 Shell',
  description: '不施加系统级约束的命令执行器，用于显式退出沙箱。',
}
