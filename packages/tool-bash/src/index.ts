import { spawn, type ChildProcess } from 'node:child_process'
import { relative, resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { ToolDefinition, ToolRunContext } from '@ruobai/tools'

export interface Config {
  /** Directory commands are confined to. Defaults to the process cwd. */
  root?: string
  /** Shell binary used to interpret the command. */
  shell?: string
  /** Default per-command timeout. */
  timeoutMs?: number
  /** Upper bound a model may request via the tool's `timeoutMs`. */
  maxTimeoutMs?: number
  /** Bytes captured per stream before truncating. */
  maxOutputBytes?: number
}

/**
 * Credentials the harness itself may hold. They are stripped from the child
 * environment so a command cannot exfiltrate them by accident.
 */
const SECRET_ENV = [
  'RBU_TOKEN',
  'RBU_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]

const MAX_COMMAND_LENGTH = 8_000

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

function resolveCwd(root: string, cwd: unknown) {
  const target = resolve(root, typeof cwd === 'string' && cwd ? cwd : '.')
  if (!inside(root, target)) throw new Error(`cwd escapes the workspace: ${String(cwd)}`)
  return target
}

function commandOf(args: any) {
  const command = typeof args?.command === 'string' ? args.command.trim() : ''
  if (!command) throw new Error('command is required')
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`command is longer than ${MAX_COMMAND_LENGTH} characters`)
  }
  return command
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of SECRET_ENV) delete env[key]
  return env
}

function shellArgs(command: string) {
  return process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
}

/** Kill the whole process group so pipes and grandchildren die with the shell. */
function killGroup(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

interface RunOptions {
  cwd: string
  shell: string
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
  onSpawn(child: ChildProcess): void
  onExit(child: ChildProcess): void
}

interface RunConfig {
  shell: string
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
}

interface Captured {
  stdout: Buffer[]
  stderr: Buffer[]
  sizes: { stdout: number; stderr: number }
  truncated: { stdout: boolean; stderr: boolean }
}

function render(captured: Captured, code: number | null, signal: NodeJS.Signals | null, duration: number) {
  const stdout = Buffer.concat(captured.stdout).toString('utf8')
  const stderr = Buffer.concat(captured.stderr).toString('utf8')
  const parts = [
    `exit code: ${code ?? 'none'}${signal ? ` · signal ${signal}` : ''} · ${duration}ms`,
  ]
  if (stdout) parts.push(`--- stdout ---\n${stdout.trimEnd()}`)
  if (stderr) parts.push(`--- stderr ---\n${stderr.trimEnd()}`)
  if (!stdout && !stderr) parts.push('(no output)')
  if (captured.truncated.stdout || captured.truncated.stderr) {
    parts.push('… output truncated')
  }
  return parts.join('\n')
}

function run(command: string, options: RunOptions): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.shell, shellArgs(command), {
      cwd: options.cwd,
      env: scrubbedEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    options.onSpawn(child)

    const started = Date.now()
    const captured: Captured = {
      stdout: [],
      stderr: [],
      sizes: { stdout: 0, stderr: 0 },
      truncated: { stdout: false, stderr: false },
    }
    let settled = false
    let failure: Error | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let force: ReturnType<typeof setTimeout> | undefined

    function collect(stream: 'stdout' | 'stderr', data: Buffer) {
      const remaining = options.maxOutputBytes - captured.sizes[stream]
      if (remaining <= 0) {
        captured.truncated[stream] = true
        return
      }
      const slice = data.length > remaining ? data.subarray(0, remaining) : data
      captured[stream].push(slice)
      captured.sizes[stream] += slice.length
      if (slice.length < data.length) captured.truncated[stream] = true
    }

    function settle(code: number | null, signal: NodeJS.Signals | null) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (force) clearTimeout(force)
      options.signal?.removeEventListener('abort', abort)
      options.onExit(child)
      const output = render(captured, code, signal, Date.now() - started)
      if (failure) rejectPromise(new Error(`${failure.message}\n\n${output}`))
      else resolvePromise(output)
    }

    function abort() {
      failure = new Error('command was cancelled')
      killGroup(child)
      force = setTimeout(() => settle(null, null), 500)
    }

    child.stdout?.on('data', (data: Buffer) => collect('stdout', data))
    child.stderr?.on('data', (data: Buffer) => collect('stderr', data))
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

function previewOf(command: string, cwd: string, root: string) {
  const lines = command.split('\n')
  const shown = lines.slice(0, 40).map((line, index) => index === 0 ? `$ ${line}` : `  ${line}`)
  if (lines.length > 40) shown.push('  …')
  const target = relative(root, cwd)
  return {
    summary: `${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''}${target ? ` · in ${target}` : ''}`,
    diff: shown.join('\n'),
  }
}

function bashTool(fallbackRoot: string, config: RunConfig, children: Set<ChildProcess>): ToolDefinition {
  const rootFor = (run?: ToolRunContext) => run?.workspace ? resolve(run.workspace) : fallbackRoot

  return {
    name: 'bash',
    description: [
      'Run a shell command in the workspace and return its output.',
      'The working directory is confined to the workspace, a timeout kills the process group,',
      'output is truncated, and harness credentials are stripped from the environment.',
      'Requires user approval.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root.' },
        timeoutMs: { type: 'number', description: `Timeout in milliseconds (max ${config.maxTimeoutMs}).` },
      },
      required: ['command'],
    },
    requiresApproval: true,
    approvalSubject(args) {
      return { kind: 'command', value: commandOf(args) }
    },
    preview(args, run) {
      const root = rootFor(run)
      const command = commandOf(args)
      return previewOf(command, resolveCwd(root, args?.cwd), root)
    },
    async execute(args, toolRun: ToolRunContext) {
      const root = rootFor(toolRun)
      const command = commandOf(args)
      const cwd = resolveCwd(root, args?.cwd)
      const requested = typeof args?.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.floor(args.timeoutMs)
        : config.timeoutMs
      const timeoutMs = Math.min(Math.max(requested, 1), config.maxTimeoutMs)

      return run(command, {
        cwd,
        shell: config.shell,
        timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: toolRun.signal,
        onSpawn: child => children.add(child),
        onExit: child => children.delete(child),
      })
    },
  }
}

/** Shell execution with approval, workspace confinement, timeouts and output caps. */
export default class BashTools {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    root: z.string().default('.'),
    shell: z.string().default(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
    timeoutMs: z.number().min(1).default(120_000),
    maxTimeoutMs: z.number().min(1).default(600_000),
    maxOutputBytes: z.number().min(1).default(32_768),
  })

  constructor(ctx: Context, config: Config) {
    const root = resolve(config.root ?? '.')
    const children = new Set<ChildProcess>()
    const resolved = {
      shell: config.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
      timeoutMs: config.timeoutMs ?? 120_000,
      maxTimeoutMs: config.maxTimeoutMs ?? 600_000,
      maxOutputBytes: config.maxOutputBytes ?? 32_768,
    }

    ctx.effect(() => {
      const dispose = ctx.tools.register(bashTool(root, resolved, children))
      return () => {
        dispose()
        for (const child of children) killGroup(child)
        children.clear()
      }
    }, 'ctx.tools.register(bash)')
  }
}

export { inside, resolveCwd }

export const meta = {
  title: 'Shell 工具',
  description: '在工作区内执行终端命令。',
}
