import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

export interface Config {
  /** Every terminal's cwd must stay inside this root. */
  root?: string
  /** Login shell; defaults to $SHELL. */
  shell?: string
  maxTerminals?: number
  /** Characters of scrollback kept for reconnects. */
  bufferChars?: number
}

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  pid?: number
  alive: boolean
  cols: number
  rows: number
  createdAt: number
  exitCode?: number | null
}

export interface CreateOptions {
  cwd?: string
  cols?: number
  rows?: number
}

declare module '@ruobai/cordis' {
  interface Context {
    terminal: TerminalService
  }

  interface Events {
    'terminal/output'(id: string, data: string): void
    'terminal/exit'(id: string, code: number | null): void
    'terminal/changed'(terminals: TerminalInfo[]): void
  }
}

interface Entry extends TerminalInfo {
  child: ChildProcess
  buffer: string
}

const MAX_INPUT = 65_536

/**
 * Interactive shells for the UI.
 *
 * A small Python helper (shipped beside this file) allocates the pty; no
 * native Node module is involved. Output is forwarded as-is and rendered by
 * xterm in the browser. These terminals are user-facing only: no tool is
 * registered for them, because a shell outside the agent's sandbox would
 * bypass the command boundary.
 */
export class TerminalService extends Service {
  static Config: z<Config> = z.object({
    root: z.string().default('.'),
    shell: z.string(),
    maxTerminals: z.number().min(1).default(6),
    bufferChars: z.number().min(1_000).default(200_000),
  })

  private readonly root: string
  private readonly shell: string
  private readonly maxTerminals: number
  private readonly bufferChars: number
  private readonly entries = new Map<string, Entry>()
  private counter = 0

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'terminal')
    this.root = resolve(config.root ?? '.')
    this.shell = config.shell || process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    this.maxTerminals = config.maxTerminals ?? 6
    this.bufferChars = config.bufferChars ?? 200_000
    if (process.platform === 'win32') {
      ctx.logger('terminal').warn('terminal requires macOS or Linux (script(1))')
    }
    ctx.effect(() => () => this.disposeAll(), 'terminal.dispose')
  }

  list(): TerminalInfo[] {
    return [...this.entries.values()].map(({ child: _child, buffer: _buffer, ...info }) => ({
      ...info,
      alive: this.alive(info.id),
    }))
  }

  create(options: CreateOptions = {}): TerminalInfo {
    if (process.platform === 'win32') throw new Error('terminal requires macOS or Linux')
    if (this.entries.size >= this.maxTerminals) {
      throw new Error(`at most ${this.maxTerminals} terminals are open`)
    }

    const cwd = resolve(this.root, options.cwd ?? '.')
    if (!inside(this.root, cwd)) throw new Error('terminal cwd escapes the workspace')
    const cols = clamp(options.cols, 100, 20, 400)
    const rows = clamp(options.rows, 30, 5, 200)

    const command = ptyCommand(this.shell)
    const child = spawn(command.file, command.args, {
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        COLUMNS: String(cols),
        LINES: String(rows),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    this.counter += 1
    const id = randomUUID()
    const entry: Entry = {
      id,
      title: this.nextTitle(),
      cwd: relative(this.root, cwd) || '.',
      pid: child.pid,
      alive: true,
      cols,
      rows,
      createdAt: Date.now(),
      child,
      buffer: '',
    }
    this.entries.set(id, entry)

    const forward = (chunk: Buffer | string) => {
      const text = String(chunk)
      entry.buffer = (entry.buffer + text).slice(-this.bufferChars)
      this.ctx.emit('terminal/output', id, text)
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('exit', (code) => {
      entry.alive = false
      entry.exitCode = code
      this.ctx.emit('terminal/exit', id, code)
      this.ctx.emit('terminal/changed', this.list())
    })
    child.on('error', (error) => {
      entry.alive = false
      this.ctx.logger('terminal').warn(error)
      const hint = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'python3 is required for the terminal; install it or use the bash tool'
        : error.message
      this.ctx.emit('terminal/output', id, `\r\n[terminal error] ${hint}\r\n`)
      this.ctx.emit('terminal/changed', this.list())
    })

    this.ctx.emit('terminal/changed', this.list())
    return this.info(entry)
  }

  write(id: string, data: unknown): void {
    const entry = this.entry(id)
    if (!entry.alive) throw new Error('terminal has exited')
    const text = String(data ?? '')
    if (!text) return
    if (text.length > MAX_INPUT) throw new Error(`input is longer than ${MAX_INPUT} characters`)
    entry.child.stdin?.write(text)
  }

  /** Control line consumed by the pty helper; a keyboard cannot emit NUL. */
  resize(id: string, cols: unknown, rows: unknown): { resized: boolean } {
    const entry = this.entry(id)
    entry.cols = clamp(cols, entry.cols, 20, 400)
    entry.rows = clamp(rows, entry.rows, 5, 200)
    if (entry.alive) entry.child.stdin?.write(`\u0000resize:${entry.rows}:${entry.cols}\n`)
    return { resized: entry.alive }
  }

  kill(id: string): void {
    const entry = this.entry(id)
    // Remove first: the exit event is asynchronous, and a `changed` frame that
    // still listed the shell would resurrect a tab the user just closed.
    this.entries.delete(id)
    terminate(entry.child)
    this.ctx.emit('terminal/changed', this.list())
  }

  buffer(id: string): string {
    return this.entry(id).buffer
  }

  /** Reuse the smallest free number so a close/open cycle stays 1, 2, 3. */
  private nextTitle(): string {
    const used = new Set([...this.entries.values()].map(entry => entry.title))
    let index = 1
    while (used.has(`终端 ${index}`)) index += 1
    return `终端 ${index}`
  }

  private info(entry: Entry): TerminalInfo {
    const { child: _child, buffer: _buffer, ...info } = entry
    return info
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`unknown terminal: ${id}`)
    return entry
  }

  private alive(id: string): boolean {
    return this.entries.get(id)?.alive ?? false
  }

  private disposeAll() {
    for (const entry of this.entries.values()) terminate(entry.child)
    this.entries.clear()
  }
}

export default TerminalService

function ptyCommand(shell: string) {
  // `script(1)` fails when its own stdio is a pipe ("tcgetattr: Operation not
  // supported on a socket"), so the pty is allocated by the helper instead.
  const helper = fileURLToPath(new URL('./pty_bridge.py', import.meta.url))
  return { file: 'python3', args: [helper, shell] }
}

function terminate(child: ChildProcess) {
  if (!child.pid) return
  try {
    // The shell must die with its process group; killing `script` alone leaves
    // the interactive shell parented to init.
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, 750)
  timer.unref()
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

export const meta = {
  title: '终端',
  description: '为界面提供交互式 shell；终端不暴露给 agent。',
}
