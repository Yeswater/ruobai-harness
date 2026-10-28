import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { relative, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

export interface Config {
  /** Project root; launch files and commands resolve against it. */
  root?: string
  /** Milliseconds to wait for the configured port. */
  startTimeoutMs?: number
  /** Log lines kept per configuration. */
  logLines?: number
  /** Pick a free port when the configured one is taken. */
  autoPort?: boolean
}

export interface PreviewConfiguration {
  name: string
  runtimeExecutable: string
  runtimeArgs?: string[]
  /** 0 means "pick a free port". */
  port?: number
  url?: string
  cwd?: string
  /** Overrides the service default for this configuration. */
  autoPort?: boolean
}

export type PreviewStatus = 'stopped' | 'starting' | 'running' | 'failed'

export interface PreviewState {
  name: string
  status: PreviewStatus
  pid?: number
  url?: string
  port?: number
  startedAt?: number
  exitCode?: number | null
  error?: string
}

export interface PreviewSnapshot {
  /** Launch file used, or the two paths that were checked. */
  path: string
  configurations: PreviewConfiguration[]
  states: PreviewState[]
  error?: string
}

declare module '@ruobai/cordis' {
  interface Context {
    preview: PreviewService
  }

  interface Events {
    'preview/state'(state: PreviewState): void
    'preview/log'(name: string, line: string): void
    'preview/changed'(): void
  }
}

interface Entry {
  child?: ChildProcess
  starting?: Promise<PreviewState>
  state: PreviewState
  logs: string[]
}

const LAUNCH_DIRS = ['.ruobai', '.claude']
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

/**
 * Development servers declared in `launch.json`.
 *
 * The file is user-authored and only the UI starts or stops a command; no tool
 * is registered for it. Commands run in their own process group so stopping a
 * `pnpm dev` also stops the tool it spawned.
 */
export class PreviewService extends Service {
  static Config: z<Config> = z.object({
    root: z.string().default('.'),
    startTimeoutMs: z.number().min(1_000).default(30_000),
    logLines: z.number().min(20).default(400),
    autoPort: z.boolean().default(true),
  })

  private readonly root: string
  private readonly timeoutMs: number
  private readonly logLines: number
  private readonly autoPort: boolean
  private readonly entries = new Map<string, Entry>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'preview')
    this.root = resolve(config.root ?? '.')
    this.timeoutMs = config.startTimeoutMs ?? 30_000
    this.logLines = config.logLines ?? 400
    this.autoPort = config.autoPort !== false
    ctx.effect(() => () => this.disposeAll(), 'preview.dispose')
  }

  async snapshot(): Promise<PreviewSnapshot> {
    const loaded = await this.load()
    return {
      path: loaded.path,
      configurations: loaded.configurations,
      states: loaded.configurations.map(item => this.stateOf(item.name)),
      ...(loaded.error ? { error: loaded.error } : {}),
    }
  }

  async logs(name: string): Promise<{ state: PreviewState; logs: string[] }> {
    await this.load()
    return { state: this.stateOf(name), logs: [...(this.entries.get(name)?.logs ?? [])] }
  }

  async start(name: string): Promise<PreviewState> {
    const loaded = await this.load()
    if (loaded.error) throw new Error(loaded.error)
    const configuration = loaded.configurations.find(item => item.name === name)
    if (!configuration) throw new Error(`unknown preview configuration: ${name}`)

    const entry = this.entryOf(name)
    if (entry.state.status === 'running' || entry.state.status === 'starting') return entry.state
    entry.starting = this.launch(configuration, entry)
    return entry.starting
  }

  async stop(name: string): Promise<PreviewState> {
    const entry = this.entries.get(name)
    if (!entry?.child) {
      this.setState(name, { name, status: 'stopped' })
      return this.stateOf(name)
    }
    const child = entry.child
    await terminate(child)
    this.setState(name, { name, status: 'stopped', ...(entry.state.port ? { port: entry.state.port } : {}) })
    return this.stateOf(name)
  }

  async restart(name: string): Promise<PreviewState> {
    await this.stop(name)
    return this.start(name)
  }

  private async launch(configuration: PreviewConfiguration, entry: Entry): Promise<PreviewState> {
    const cwd = resolve(this.root, configuration.cwd ?? '.')
    if (!inside(this.root, cwd)) throw new Error(`preview cwd escapes the workspace: ${configuration.cwd}`)

    const configuredPort = configuration.port ?? portOf(configuration.url)
    const auto = configuration.autoPort ?? this.autoPort
    let port = configuredPort
    let url = configuration.url ?? (configuredPort ? `http://127.0.0.1:${configuredPort}` : undefined)

    entry.logs = []
    if (port !== undefined) {
      if (port === 0 || await portInUse(port)) {
        if (port !== 0 && !auto) {
          this.setState(configuration.name, {
            name: configuration.name,
            status: 'failed',
            port,
            ...(url ? { url } : {}),
            error: `port ${port} is already in use (set autoPort to pick another)`,
          })
          return this.stateOf(configuration.name)
        }
        const next = await freePort()
        this.appendLog(configuration.name, `port ${port === 0 ? '(auto)' : port} is in use; using ${next}`)
        port = next
        if (url && configuredPort !== undefined) url = withPort(url, next)
        else if (!url) url = `http://127.0.0.1:${port}`
      }
    }

    this.setState(configuration.name, {
      name: configuration.name,
      status: 'starting',
      ...(port ? { port } : {}),
      ...(url ? { url } : {}),
      startedAt: Date.now(),
    })
    this.appendLog(configuration.name, `$ ${configuration.runtimeExecutable} ${(configuration.runtimeArgs ?? []).join(' ')}`)

    const child = spawn(configuration.runtimeExecutable, (configuration.runtimeArgs ?? []).map(arg =>
      port !== undefined ? arg.replaceAll('{port}', String(port)) : arg,
    ), {
      cwd,
      // The parent harness may itself be running with PORT set; the child must
      // never inherit it, or `pnpm dev` tries to bind the same port.
      env: { ...process.env, ...(port !== undefined ? { PORT: String(port) } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    entry.child = child

    const forward = (chunk: Buffer | string) => {
      const text = String(chunk)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.appendLog(configuration.name, line.replace(ANSI, ''))
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)

    const exited = new Promise<number | null>((resolveExit) => {
      child.once('exit', (code) => resolveExit(code))
      child.once('error', (error) => {
        this.appendLog(configuration.name, `[spawn error] ${error.message}`)
        resolveExit(-1)
      })
    })

    if (port) {
      const ready = await Promise.race([
        waitForPort(port, this.timeoutMs).then(() => 'ready' as const),
        exited.then(code => ({ code })),
      ])
      if (ready !== 'ready') {
        const code = typeof ready === 'object' ? ready.code : null
        this.setState(configuration.name, {
          name: configuration.name,
          status: 'failed',
          error: `process exited before port ${port} was ready${code !== null ? ` (code ${code})` : ''}`,
          ...(port ? { port } : {}),
          ...(url ? { url } : {}),
          startedAt: Date.now(),
          exitCode: code,
        })
        entry.child = undefined
        return this.stateOf(configuration.name)
      }
    }

    child.once('exit', (code) => {
      // A server that stops on its own must not stay "running" in the UI.
      if (!entry.child) return
      entry.child = undefined
      this.setState(configuration.name, {
        name: configuration.name,
        status: 'stopped',
        ...(url ? { url } : {}),
        ...(port ? { port } : {}),
        exitCode: code,
      })
    })

    this.setState(configuration.name, {
      name: configuration.name,
      status: 'running',
      pid: child.pid,
      ...(port ? { port } : {}),
      ...(url ? { url } : {}),
      startedAt: entry.state.startedAt,
    })
    return this.stateOf(configuration.name)
  }

  private stateOf(name: string): PreviewState {
    return this.entries.get(name)?.state ?? { name, status: 'stopped' }
  }

  private entryOf(name: string): Entry {
    const existing = this.entries.get(name)
    if (existing) return existing
    const entry: Entry = { state: { name, status: 'stopped' }, logs: [] }
    this.entries.set(name, entry)
    return entry
  }

  private setState(name: string, state: PreviewState) {
    this.entryOf(name).state = state
    this.ctx.emit('preview/state', state)
    this.ctx.emit('preview/changed')
  }

  private appendLog(name: string, line: string) {
    const entry = this.entryOf(name)
    entry.logs.push(line.slice(0, 2_000))
    if (entry.logs.length > this.logLines) entry.logs.splice(0, entry.logs.length - this.logLines)
    this.ctx.emit('preview/log', name, line.slice(0, 2_000))
  }

  private async load(): Promise<{ path: string; configurations: PreviewConfiguration[]; error?: string }> {
    for (const dir of LAUNCH_DIRS) {
      const path = resolve(this.root, dir, 'launch.json')
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        continue
      }
      try {
        const parsed = JSON.parse(raw) as { configurations?: unknown }
        const configurations = normalizeConfigurations(parsed?.configurations)
        const shown = relative(this.root, path) || path
        this.pruneStates(configurations)
        return { path: shown, configurations }
      } catch (error) {
        const shown = relative(this.root, path) || path
        return {
          path: shown,
          configurations: [],
          error: `${shown}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    return { path: `${LAUNCH_DIRS[0]}/launch.json`, configurations: [] }
  }

  private pruneStates(configurations: PreviewConfiguration[]) {
    const names = new Set(configurations.map(item => item.name))
    for (const [name, entry] of this.entries) {
      if (names.has(name) || entry.child) continue
      this.entries.delete(name)
    }
  }

  private disposeAll() {
    for (const entry of this.entries.values()) {
      if (entry.child) void terminate(entry.child)
    }
    this.entries.clear()
  }
}

export default PreviewService

export function normalizeConfigurations(raw: unknown): PreviewConfiguration[] {
  if (!Array.isArray(raw)) throw new Error('configurations must be an array')
  const seen = new Set<string>()
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`configuration ${index + 1} is not an object`)
    const value = item as Record<string, unknown>
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name) throw new Error(`configuration ${index + 1} has no name`)
    if (seen.has(name)) throw new Error(`duplicate configuration name: ${name}`)
    seen.add(name)
    const executable = typeof value.runtimeExecutable === 'string' ? value.runtimeExecutable.trim() : ''
    if (!executable) throw new Error(`configuration "${name}" has no runtimeExecutable`)
    let args: string[] = []
    if (value.runtimeArgs !== undefined) {
      if (!Array.isArray(value.runtimeArgs) || !value.runtimeArgs.every(arg => typeof arg === 'string')) {
        throw new Error(`configuration "${name}" has invalid runtimeArgs`)
      }
      args = value.runtimeArgs as string[]
    }
    const port = value.port === undefined ? undefined : Number(value.port)
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
      throw new Error(`configuration "${name}" has an invalid port`)
    }
    const autoPort = value.autoPort === undefined ? undefined : Boolean(value.autoPort)
    const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : undefined
    if (url && !/^https?:\/\//.test(url)) throw new Error(`configuration "${name}" url must be http(s)`)
    const cwd = typeof value.cwd === 'string' && value.cwd.trim() ? value.cwd.trim() : undefined
    return {
      name,
      runtimeExecutable: executable,
      runtimeArgs: args,
      ...(port !== undefined ? { port } : {}),
      ...(url ? { url } : {}),
      ...(cwd ? { cwd } : {}),
      ...(autoPort !== undefined ? { autoPort } : {}),
    }
  })
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (inUse: boolean) => {
      socket.destroy()
      resolveCheck(inUse)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function withPort(url: string, port: number): string {
  const parsed = new URL(url)
  parsed.port = String(port)
  const bare = parsed.pathname === '/' && !parsed.search && !parsed.hash
  return bare ? `${parsed.protocol}//${parsed.host}` : parsed.toString()
}

function portOf(url?: string): number | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.port) return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return undefined
  }
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePort, reject) => {
    const attempt = () => {
      const socket = connect({ port, host: '127.0.0.1' })
      const done = (error?: Error) => {
        socket.destroy()
        if (!error) return resolvePort()
        if (Date.now() >= deadline) return reject(new Error(`port ${port} was not ready within ${timeoutMs} ms`))
        setTimeout(attempt, 250)
      }
      socket.setTimeout(1_000)
      socket.once('connect', () => done())
      socket.once('timeout', () => done(new Error('timeout')))
      socket.once('error', error => done(error))
    }
    attempt()
  })
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit())
  })
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const forced = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, 2_000)
  forced.unref()
  await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 3_000))])
  clearTimeout(forced)
}

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

export const meta = {
  title: '预览服务器',
  description: '按 .ruobai/launch.json 启停本地开发服务器并转发日志。',
}
