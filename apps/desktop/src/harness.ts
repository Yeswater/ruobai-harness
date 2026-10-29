import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** The CLI prints this once the HTTP server is listening. */
export const READY_PREFIX = '[ruobai-harness] ui: '

export interface HarnessCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface HarnessOptions {
  /** Repository that owns `cordis.yml` and the CLI. */
  root: string
  /** Directory the harness works on; becomes the child's cwd. */
  workspace: string
  /** Node binary. Defaults to `RUOBAI_NODE` or `node` from PATH. */
  node?: string
  /** Override the CLI entry (a `.ts` entry runs through tsx). */
  entry?: string
  env?: NodeJS.ProcessEnv
  onLog?: (line: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  timeoutMs?: number
}

export function extractReadyUrl(line: string): string | undefined {
  const index = line.indexOf(READY_PREFIX)
  if (index < 0) return undefined
  const candidate = line.slice(index + READY_PREFIX.length).trim()
  if (!/^https?:\/\//.test(candidate)) return undefined
  try {
    return new URL(candidate).toString()
  } catch {
    return undefined
  }
}

function findEntry(root: string): string {
  for (const candidate of [join(root, 'apps/cli/src/bin.ts'), join(root, 'apps/cli/dist/bin.js')]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`harness entry not found under ${root}`)
}

export function resolveHarnessCommand(options: HarnessOptions): HarnessCommand {
  const entry = options.entry ?? process.env.RUOBAI_HARNESS_ENTRY ?? findEntry(options.root)
  const config = join(options.root, 'cordis.yml')
  if (!existsSync(config)) throw new Error(`cordis.yml not found under ${options.root}`)

  const args: string[] = []
  if (entry.endsWith('.ts')) {
    const require = createRequire(import.meta.url)
    args.push(require.resolve('tsx/cli', { paths: [options.root] }))
  }
  args.push(entry, config, '--workspace', options.workspace, '--port', '0')

  return {
    command: options.node ?? process.env.RUOBAI_NODE ?? 'node',
    args,
    env: { ...process.env, ...options.env },
  }
}

function signalTree(pid: number, signal: NodeJS.Signals) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  // The child is a process-group leader, so this reaches sandbox-exec, ptys
  // and anything else the harness spawned.
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

/**
 * Owns exactly one harness child process.
 *
 * The desktop never imports the harness: it starts the same CLI `pnpm dev`
 * starts and reads the UI URL from stdout. That keeps Cordis out of Electron
 * and lets the two sides be developed and stopped independently.
 */
export class HarnessProcess {
  private child?: ChildProcess
  private stopping = false
  private ready = false
  private stderr: string[] = []

  get url(): string | undefined {
    return this.ready ? this.currentUrl : undefined
  }

  private currentUrl?: string

  async start(options: HarnessOptions): Promise<string> {
    if (this.child) throw new Error('harness is already running')

    const { command, args, env } = resolveHarnessCommand(options)
    this.stopping = false
    this.ready = false
    this.currentUrl = undefined
    this.stderr = []

    const child = spawn(command, args, {
      cwd: options.workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.child = child

    const timeoutMs = options.timeoutMs ?? 60_000

    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        fail(new Error(`harness did not report a UI URL within ${timeoutMs}ms\n${tail(this.stderr)}`))
      }, timeoutMs)

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // A start that fails still owns a process (timeout, bad output): kill
        // its group instead of leaving the harness running headless.
        const pid = this.child?.pid
        if (pid) {
          this.stopping = true
          signalTree(pid, 'SIGTERM')
        }
        reject(error)
      }

      const succeed = (url: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ready = true
        this.currentUrl = url
        resolve(url)
      }

      const onStdout = (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          options.onLog?.(line)
          const url = extractReadyUrl(line)
          if (url) succeed(url)
        }
      }

      let buffer = ''
      const onStderr = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        options.onLog?.(text.trimEnd())
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) this.stderr.push(line)
        }
        if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200)
      }

      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)

      child.once('error', error => {
        this.child = undefined
        fail(error)
      })

      child.once('exit', (code, signal) => {
        this.child = undefined
        const stopped = this.stopping
        this.ready = false
        this.currentUrl = undefined
        if (!settled) {
          fail(new Error(`harness exited before it was ready (code ${code}, signal ${signal})\n${tail(this.stderr)}`))
          return
        }
        if (!stopped) options.onExit?.(code, signal)
      })
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child?.pid || child.exitCode !== null) return
    this.stopping = true
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    signalTree(child.pid, 'SIGTERM')
    const force = setTimeout(() => {
      if (child.pid) signalTree(child.pid, 'SIGKILL')
    }, 5000)
    await exited
    clearTimeout(force)
  }
}

function tail(lines: string[]) {
  return lines.slice(-20).join('\n')
}
