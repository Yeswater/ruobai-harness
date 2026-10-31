import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import type {} from '@ruobai/settings'
import z from '@ruobai/schemastery'

export interface Config {
  /** `auto` picks the OS keychain on macOS and the file store elsewhere. */
  provider?: 'auto' | 'keychain' | 'file'
  /** File backend location; relative paths resolve against `process.cwd()`. */
  path?: string
  /** Keychain service name shared by every item this harness writes. */
  service?: string
  /** Move plaintext keys out of settings.json on startup. */
  migrate?: boolean
}

declare module '@ruobai/cordis' {
  interface Context {
    secrets: SecretsService
  }
}

/** Narrow contract settings uses; kept structural so the two packages stay decoupled. */
export interface SecretStore {
  readonly backend: string
  get(key: string): string | undefined
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

interface Backend {
  readonly name: 'keychain' | 'file'
  load(): Promise<Map<string, string>>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

class SecretsError extends Error {}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,120}$/i

/**
 * Secret storage for API keys and tokens.
 *
 * Values are cached in memory after `load()` so callers on synchronous paths
 * (settings' `apiKeyFor`) can read them. Writes go to the OS keychain when
 * available, otherwise to a 0600 file under `.ruobai/`. Neither backend ever
 * writes a value into `.ruobai/settings.json`.
 */
export class SecretsService extends Service implements SecretStore {
  static Config: z<Config> = z.object({
    provider: z.union([z.const('auto'), z.const('keychain'), z.const('file')]).default('auto'),
    path: z.string().default('.ruobai/secrets.json'),
    service: z.string().default('ruobai-harness'),
    migrate: z.boolean().default(true),
  })

  static inject = ['settings']

  readonly backend: 'keychain' | 'file'
  private readonly store: Backend
  private values = new Map<string, string>()
  private queue: Promise<void> = Promise.resolve()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'secrets')
    this.backend = chooseBackend(config)
    const path = resolve(config.path ?? '.ruobai/secrets.json')
    this.store = this.backend === 'keychain'
      ? new KeychainBackend(config.service ?? 'ruobai-harness', keyIndexPath(path))
      : new FileBackend(path)
  }

  async *[Service.init]() {
    this.values = await this.store.load()
    if (this.config.migrate !== false) {
      const adopted = await this.ctx.settings.adoptSecrets(this)
      // `adoptSecrets` writes through this service, so the cache is already current.
      if (adopted) this.ctx.logger('secrets').info(`moved ${adopted} secret(s) to ${this.backend}`)
    }
    yield () => undefined
  }

  get(key: string): string | undefined {
    return this.values.get(key)
  }

  has(key: string): boolean {
    return this.values.has(key)
  }

  async set(key: string, value: string): Promise<void> {
    assertKey(key)
    if (!value) throw new SecretsError('secret value is empty')
    // The keychain CLI reads one line per prompt; multi-line values would be
    // silently truncated, and no supported credential contains a newline.
    if (/[\r\n]/.test(value)) throw new SecretsError('secret value must be a single line')
    await this.serialize(async () => {
      await this.store.set(key, value)
      this.values.set(key, value)
    })
  }

  async delete(key: string): Promise<void> {
    assertKey(key)
    await this.serialize(async () => {
      await this.store.delete(key)
      this.values.delete(key)
    })
  }

  /** Keys currently held, without values. Safe to log or return over the wire. */
  keys(): string[] {
    return [...this.values.keys()].sort()
  }

  /** Writes are serialized; a failed write must not poison the next one. */
  private async serialize(task: () => Promise<void>) {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    try {
      await run
    } catch (error) {
      this.ctx.logger('secrets').error(error)
      throw error
    }
  }
}

function chooseBackend(config: Config): 'keychain' | 'file' {
  const choice = config.provider ?? 'auto'
  if (choice === 'auto') return process.platform === 'darwin' ? 'keychain' : 'file'
  return choice
}

function assertKey(key: string) {
  if (!KEY_PATTERN.test(key)) throw new SecretsError(`invalid secret key: ${key}`)
}

function keyIndexPath(secretsPath: string) {
  return `${secretsPath}.keys`
}

async function writePrivate(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, contents, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
  await chmod(path, 0o600).catch(() => undefined)
}

class FileBackend implements Backend {
  readonly name = 'file'
  private values = new Map<string, string>()

  constructor(private readonly path: string) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>
      this.values = new Map(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.values = new Map()
    }
    return new Map(this.values)
  }

  async set(key: string, value: string) {
    this.values.set(key, value)
    await this.persist()
  }

  async delete(key: string) {
    if (!this.values.delete(key)) return
    await this.persist()
  }

  private async persist() {
    const body = Object.fromEntries([...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)))
    await writePrivate(this.path, JSON.stringify(body, null, 2) + '\n')
  }
}

/**
 * macOS keychain via the `security` CLI.
 *
 * The password is fed through stdin (both prompts) rather than `-w`, so it
 * never appears in the process argument list. The key index is a plain list of
 * names: keychain items cannot be enumerated cheaply, and the index holds no
 * secret material.
 */
class KeychainBackend implements Backend {
  readonly name = 'keychain'
  private keys = new Set<string>()

  constructor(private readonly service: string, private readonly index: string) {}

  async load() {
    this.keys = new Set(await this.readIndex())
    const values = new Map<string, string>()
    for (const key of this.keys) {
      const result = await runSecurity(['find-generic-password', '-s', this.service, '-a', key, '-w'])
      if (result.code === 0) values.set(key, result.stdout.replace(/\r?\n$/, ''))
      else if (result.code === 44) this.keys.delete(key)
      else throw new SecretsError(`keychain read failed for "${key}": ${result.stderr.trim()}`)
    }
    return values
  }

  async set(key: string, value: string) {
    // `security` prompts for the password on the controlling terminal, never on
    // stdin; piping the value makes a non-TTY child hang until the timeout. The
    // value is only visible to the same user via `ps` for the child's lifetime.
    const result = await runSecurity(['add-generic-password', '-U', '-s', this.service, '-a', key, '-w', value])
    if (result.code !== 0) throw new SecretsError(`keychain write failed for "${key}": ${result.stderr.trim()}`)
    if (!this.keys.has(key)) {
      this.keys.add(key)
      await this.writeIndex()
    }
  }

  async delete(key: string) {
    const result = await runSecurity(['delete-generic-password', '-s', this.service, '-a', key])
    if (result.code !== 0 && result.code !== 44) {
      throw new SecretsError(`keychain delete failed for "${key}": ${result.stderr.trim()}`)
    }
    if (this.keys.delete(key)) await this.writeIndex()
  }

  private async readIndex(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.index, 'utf8')) as { keys?: unknown }
      return Array.isArray(parsed.keys) ? parsed.keys.filter((key): key is string => typeof key === 'string') : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return []
    }
  }

  private async writeIndex() {
    await writePrivate(this.index, JSON.stringify({ keys: [...this.keys].sort() }, null, 2) + '\n')
  }
}

function runSecurity(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('security', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      const detail = Buffer.concat(err).toString('utf8').trim()
      finish(new SecretsError(
        `security ${args[0]} timed out after 10s${detail ? `: ${detail}` : ''}`,
      ))
    }, 10_000)

    const finish = (error?: Error, code = child.exitCode ?? 1) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (error) reject(error)
      else resolvePromise({ code, stdout, stderr })
    }

    child.stdout.on('data', chunk => out.push(chunk as Buffer))
    child.stderr.on('data', chunk => err.push(chunk as Buffer))
    child.on('error', error => finish(error))
    child.on('close', code => finish(undefined, code ?? 1))

    child.stdin.end(input ?? '')
  })
}

export default SecretsService

export const meta = {
  title: '密钥保管',
  description: '把 API key 与 token 存进系统钥匙串或 0600 文件，不再写进 settings.json。',
}
