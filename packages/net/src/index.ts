import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Service, type Context } from '@ruobai/cordis'
import type {} from '@ruobai/settings'
import z from '@ruobai/schemastery'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

const execFileAsync = promisify(execFile)

export interface Config {
  /** Hosts never sent through the proxy; `*.suffix` matches a suffix. */
  bypass?: string[]
  /** How long a detected system proxy is reused. */
  detectTtlMs?: number
}

export interface ProxyValues {
  http?: string
  https?: string
  noProxy?: string
}

export interface DetectedProxy extends ProxyValues {
  source: 'scutil' | 'environment' | 'none'
  /** True when at least one HTTP(S) proxy was found. */
  supported: boolean
  socks?: string
  detail?: string
}

export interface NetworkStatus {
  enabled: boolean
  overrides: { httpProxy?: string; httpsProxy?: string; noProxy?: string }
  detected: DetectedProxy
  effective: ProxyValues & { noProxy?: string }
  bypass: string[]
  error?: string
}

export interface NetworkCheck {
  ok: boolean
  status?: number
  latencyMs?: number
  viaProxy: boolean
  proxy?: string
  error?: string
}

declare module '@ruobai/cordis' {
  interface Context {
    net: NetService
  }
}

const DEFAULT_BYPASS = ['localhost', '127.0.0.1', '::1', '[::1]', '*.local']

/** Manual URLs accept a bare `host:port`; only HTTP proxies are supported. */
export function normalizeProxyUrl(raw?: string): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('代理地址格式不正确，例如 http://127.0.0.1:7890')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 HTTP / HTTPS 代理；SOCKS 请改用 HTTP 端口')
  }
  if (!url.hostname) throw new Error('代理地址缺少主机名')
  return `${url.protocol}//${url.host}`
}

/** NO_PROXY uses leading-dot suffixes rather than globs. */
export function normalizeNoProxy(raw?: string, fallback: string[] = DEFAULT_BYPASS): string {
  const rules = raw?.trim()
    ? raw.split(',').map(part => part.trim()).filter(Boolean)
    : fallback
  return [...new Set(rules.map((rule) => {
    const stripped = rule.replace(/^\[(.*)\]$/, '$1')
    return stripped.startsWith('*.') ? stripped.slice(1) : stripped
  }))].join(',')
}

/** Environment for child processes: curl, git, gh and language tooling read these. */
export function buildProxyEnv(values: ProxyValues, bypass: string[] = DEFAULT_BYPASS): Record<string, string> {
  const env: Record<string, string> = {}
  if (values.http) {
    env.HTTP_PROXY = values.http
    env.http_proxy = values.http
  }
  if (values.https) {
    env.HTTPS_PROXY = values.https
    env.https_proxy = values.https
  }
  const all = values.https ?? values.http
  if (all) {
    env.ALL_PROXY = all
    env.all_proxy = all
  }
  if (values.http || values.https) {
    const noProxy = normalizeNoProxy(values.noProxy, bypass)
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }
  return env
}

/**
 * One outbound HTTP path for the harness.
 *
 * Node's global fetch ignores proxy environment variables, so callers use
 * `ctx.net.fetch` instead. Settings → 网络 holds application-level
 * HTTP_PROXY / HTTPS_PROXY / NO_PROXY; empty fields inherit the system proxy
 * (macOS `scutil --proxy` or HTTPS_PROXY in the environment). Application
 * values always win. Local hosts bypass the proxy entirely.
 */
export class NetService extends Service {
  static inject = ['settings']

  static Config: z<Config> = z.object({
    bypass: z.array(z.string()).default(DEFAULT_BYPASS),
    detectTtlMs: z.number().min(0).default(15_000),
  })

  private agent?: { url: string; dispatcher: ProxyAgent }
  private cached?: { at: number; value: DetectedProxy }

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'net')
    // Call sites pass `ctx.net.fetch` around as a plain function; keep the
    // receiver so `this.ctx.settings` still resolves inside it.
    this.fetch = this.fetch.bind(this)
  }

  async *[Service.init]() {
    yield () => {
      void this.agent?.dispatcher.close()
      this.agent = undefined
    }
  }

  async detect(force = false): Promise<DetectedProxy> {
    const ttl = this.config.detectTtlMs ?? 15_000
    if (!force && this.cached && Date.now() - this.cached.at < ttl) return this.cached.value
    const value = process.platform === 'darwin' ? await detectMacos() : detectEnvironment()
    this.cached = { at: Date.now(), value }
    return value
  }

  async status(force = false): Promise<NetworkStatus> {
    const resolved = await this.resolve(force)
    return {
      enabled: resolved.enabled,
      overrides: resolved.overrides,
      detected: resolved.detected,
      effective: resolved.effective,
      bypass: resolved.bypass,
      ...(resolved.error ? { error: resolved.error } : {}),
    }
  }

  /** Drop-in replacement for global fetch that honors the configured proxy. */
  async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const target = requestUrl(input)
    if (!target || this.bypassed(target)) return fetch(input, init)
    const resolved = await this.resolve()
    if (!resolved.enabled) return fetch(input, init)
    const proxy = target.protocol === 'https:' ? resolved.effective.https : resolved.effective.http
    if (!proxy) return fetch(input, init)
    const dispatcher = this.agentFor(proxy)
    return undiciFetch(input as never, { ...init, dispatcher } as never) as unknown as Promise<Response>
  }

  /** Proxy variables to merge into a child process env; empty when direct. */
  async subprocessEnv(): Promise<Record<string, string>> {
    const resolved = await this.resolve()
    if (!resolved.enabled) return {}
    return buildProxyEnv(resolved.effective, resolved.bypass)
  }

  /** Probe a URL through the current settings; any HTTP status counts as reachable. */
  async check(target = 'https://www.gstatic.com/generate_204'): Promise<NetworkCheck> {
    const resolved = await this.resolve()
    const proxy = requestUrl(target)?.protocol === 'https:'
      ? resolved.effective.https
      : resolved.effective.http
    const started = Date.now()
    try {
      const response = await this.fetch(target, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      })
      await response.body?.cancel().catch(() => undefined)
      return {
        ok: true,
        status: response.status,
        latencyMs: Date.now() - started,
        viaProxy: Boolean(proxy),
        ...(proxy ? { proxy } : {}),
      }
    } catch (caught) {
      return {
        ok: false,
        viaProxy: Boolean(proxy),
        ...(proxy ? { proxy } : {}),
        error: caught instanceof Error ? caught.message : String(caught),
      }
    }
  }

  private async resolve(force = false): Promise<{
    enabled: boolean
    overrides: NetworkStatus['overrides']
    detected: DetectedProxy
    effective: ProxyValues
    bypass: string[]
    error?: string
  }> {
    const network = this.ctx.settings.get().network
    const legacy = network as (typeof network & { proxy?: 'off' | 'system' | 'manual'; url?: string }) | undefined
    // `proxy`/`url` are the short-lived first shape of this feature.
    const enabled = network?.enabled ?? (legacy?.proxy === 'system' || legacy?.proxy === 'manual')
    const overrides = {
      ...(network?.httpProxy ? { httpProxy: network.httpProxy } : {}),
      ...(network?.httpsProxy ? { httpsProxy: network.httpsProxy } : {}),
      ...(network?.noProxy ? { noProxy: network.noProxy } : {}),
    }
    const detected = await this.detect(force)
    const bypass = this.config.bypass ?? DEFAULT_BYPASS
    const legacyUrl = legacy?.proxy === 'manual' ? legacy.url : undefined

    let http: string | undefined
    let https: string | undefined
    let error: string | undefined
    try {
      http = normalizeProxyUrl(network?.httpProxy ?? legacyUrl) ?? detected.http
      https = normalizeProxyUrl(network?.httpsProxy ?? legacyUrl) ?? detected.https ?? http
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }

    if (enabled && !http && !https) {
      error ??= detected.socks
        ? '系统只开启了 SOCKS 代理；请填写 HTTP 代理端口'
        : '没有可用的代理地址'
    }

    return {
      enabled,
      overrides,
      detected,
      effective: enabled
        ? {
            ...(http ? { http } : {}),
            ...(https ? { https } : {}),
            noProxy: normalizeNoProxy(network?.noProxy, bypass),
          }
        : { noProxy: normalizeNoProxy(network?.noProxy, bypass) },
      bypass,
      ...(error ? { error } : {}),
    }
  }

  private agentFor(url: string): ProxyAgent {
    if (this.agent?.url === url) return this.agent.dispatcher
    void this.agent?.dispatcher.close()
    const dispatcher = new ProxyAgent(url)
    this.agent = { url, dispatcher }
    return dispatcher
  }

  private bypassed(target: URL): boolean {
    const host = target.hostname.toLowerCase()
    return (this.config.bypass ?? DEFAULT_BYPASS).some((rule) => {
      const normalized = rule.toLowerCase()
      if (!normalized) return false
      if (normalized.startsWith('*.')) return host.endsWith(normalized.slice(1))
      return host === normalized
    })
  }
}

function normalizeSafe(raw?: string): string | undefined {
  try {
    return normalizeProxyUrl(raw)
  } catch {
    return undefined
  }
}

function requestUrl(input: string | URL | Request): URL | undefined {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    return new URL(input.url)
  } catch {
    return undefined
  }
}

async function detectMacos(): Promise<DetectedProxy> {
  try {
    const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: 3_000 })
    const fields = new Map<string, string>()
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/)
      if (match) fields.set(match[1]!, match[2]!)
    }

    const proxy = (prefix: 'HTTPS' | 'HTTP') => {
      if (fields.get(`${prefix}Enable`) !== '1') return undefined
      const host = fields.get(`${prefix}Proxy`)
      const port = Number(fields.get(`${prefix}Port`))
      if (!host || !Number.isFinite(port)) return undefined
      return `http://${host}:${port}`
    }

    const http = proxy('HTTP')
    const https = proxy('HTTPS') ?? http
    const socks = fields.get('SOCKSEnable') === '1'
      && fields.get('SOCKSProxy')
      ? `socks5://${fields.get('SOCKSProxy')}:${fields.get('SOCKSPort')}`
      : undefined

    if (http || https) return { http, https, source: 'scutil', supported: true }
    if (socks) {
      return {
        socks,
        source: 'scutil',
        supported: false,
        detail: '系统只开启了 SOCKS 代理；请填写 HTTP 代理端口',
      }
    }
    return { source: 'none', supported: false, detail: '系统没有开启 HTTP 代理' }
  } catch (caught) {
    return {
      source: 'none',
      supported: false,
      detail: `读取系统代理失败：${caught instanceof Error ? caught.message : String(caught)}`,
    }
  }
}

function detectEnvironment(): DetectedProxy {
  const http = process.env.HTTP_PROXY || process.env.http_proxy
  const https = process.env.HTTPS_PROXY || process.env.https_proxy
  const noProxy = process.env.NO_PROXY || process.env.no_proxy
  if (!http && !https) {
    return { source: 'none', supported: false, detail: '没有检测到代理环境变量' }
  }
  return {
    source: 'environment',
    supported: true,
    ...(http ? { http: normalizeSafe(http) } : {}),
    ...(https ? { https: normalizeSafe(https) } : {}),
    ...(noProxy ? { noProxy } : {}),
  }
}

export default NetService

export const meta = {
  title: '网络代理',
  description: '为模型的 HTTP 请求与命令子进程提供应用级 HTTP_PROXY / HTTPS_PROXY / NO_PROXY；默认继承系统代理。',
}
