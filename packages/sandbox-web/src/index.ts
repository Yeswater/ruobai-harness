import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'
import { DEFAULT_ALLOWED_DOMAINS, DEFAULT_EXCLUDED_COMMANDS } from '@ruobai/sandbox'
import type { SandboxService } from '@ruobai/sandbox'
import type { DenialService } from '@ruobai/sandbox-denial'
import type { EscalationService } from '@ruobai/sandbox-escalation'
import type { SandboxPolicyService } from '@ruobai/sandbox-policy'
import type { SandboxProxyService } from '@ruobai/sandbox-proxy'
import type { SandboxSettings, SettingsService } from '@ruobai/settings'
import type { ShellService } from '@ruobai/shell'

export const name = 'sandbox-web'
export const inject = ['web', 'sandbox', 'sandboxPolicy', 'denial', 'settings', 'shell']

/** Effective sandbox settings, with defaults filled in for the panel. */
export interface SandboxConfigView {
  enabled: boolean
  autoAllowBashIfSandboxed: boolean
  allowUnsandboxedCommands: boolean
  excludedCommands: string[]
  network: {
    allowedDomains: string[]
    allowLocalBinding: boolean
  }
  filesystem: {
    allowWrite: string[]
  }
}

export function sandboxConfigOf(ctx: Context): SandboxConfigView {
  const settings = ctx.get('settings', false) as SettingsService | undefined
  const sandbox = settings?.get().sandbox
  return {
    enabled: sandbox?.enabled !== false,
    autoAllowBashIfSandboxed: sandbox?.autoAllowBashIfSandboxed !== false,
    allowUnsandboxedCommands: sandbox?.allowUnsandboxedCommands !== false,
    excludedCommands: [...(sandbox?.excludedCommands ?? DEFAULT_EXCLUDED_COMMANDS)],
    network: {
      allowedDomains: [...(sandbox?.network?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS)],
      allowLocalBinding: sandbox?.network?.allowLocalBinding !== false,
    },
    filesystem: {
      allowWrite: [...(sandbox?.filesystem?.allowWrite ?? [])],
    },
  }
}

/**
 * Status projection for the sandbox.
 *
 * Read-mostly: the writes are the global enable switch and a *session-scoped*
 * escalation switch. Policy editing (guards, network mode, write roots) is not
 * exposed over HTTP — see docs/sandbox-macos.md §7 for why it belongs in a
 * reviewed file rather than a click.
 */
export interface SandboxStatus {
  /** User switch from settings; false means commands run through the direct executor. */
  enabled: boolean
  /** Whether a provider is registered *and* passed its self-check. */
  active: boolean
  provider?: {
    id: string
    platform: string
    capabilities: string[]
    /** sha256 of the compiled profile, for "is this the same policy?" checks. */
    profileDigest?: string
    failure?: string
  }
  /** Reason the sandbox is unavailable, when it is. */
  unavailable?: string
  /** Effective, user-editable policy (defaults filled in). */
  settings: SandboxConfigView
  /** Loopback egress proxy state. Absent when the proxy plugin is not mounted. */
  proxy?: {
    active: boolean
    port: number
    domains: number
    allowLocalBinding: boolean
    upstream?: string
  }
  policy: {
    version: number
    root: string
    read: Array<{ path: string; recursive: boolean }>
    write: Array<{ path: string; recursive: boolean }>
    exec: string[]
    network: { mode: string; allow: unknown[]; allowLocalBinding?: boolean }
  }
  guards: Array<{ id: string; path: string; match: string; access: string; reason: string; owner?: string }>
  denials: {
    total: number
    counts: Record<string, number>
    recent: Array<{
      id: string
      kind: string
      target?: string
      guard?: string
      evidence: string
      confidence: string
      repeated: number
      command: string
      at: number
      message: string
    }>
  }
  escalation: {
    /** `auto` escalates relaxable denials; `never` reports them only. */
    mode: 'auto' | 'never'
    sessionGrants: Array<{ key: string; exemption?: unknown; retry: string }>
    relaxability: Array<{ kind: string; relaxable: boolean; reason: string }>
  }
}

/**
 * Session switch accessor.
 *
 * The authoritative state lives in `EscalationService`, not here: this plugin
 * is only the HTTP door, so the executor and the panel can never disagree
 * about whether escalation is on.
 */
function escalationOf(ctx: Context): EscalationService | undefined {
  return ctx.get('escalation', false) as EscalationService | undefined
}

async function statusOf(ctx: Context, sessionId: string): Promise<SandboxStatus> {
  const sandbox = ctx.get('sandbox') as SandboxService
  const policyService = ctx.get('sandboxPolicy') as SandboxPolicyService
  const denial = ctx.get('denial') as DenialService
  const escalation = escalationOf(ctx)
  const proxy = ctx.get('sandboxProxy', false) as SandboxProxyService | undefined

  const provider = sandbox.provider()
  const snapshot = policyService.forSession({
    sessionId,
    ...(proxy?.active ? { proxyPort: proxy.port } : {}),
  })
  const recent = denial.recent()
  const settings = ctx.get('settings', false) as SettingsService | undefined

  return {
    enabled: settings ? settings.sandboxEnabled() : true,
    active: Boolean(provider),
    settings: sandboxConfigOf(ctx),
    ...(proxy ? { proxy: await proxy.summary() } : {}),
    ...(provider
      ? {
        provider: {
          id: provider.id,
          platform: provider.platform,
          capabilities: [...provider.capabilities],
          profileDigest: provider.extensions?.profileDigest as string | undefined,
          failure: provider.extensions?.failure as string | undefined,
        },
      }
      : {}),
    ...(provider ? {} : { unavailable: 'no sandbox provider is registered for this platform' }),
    policy: {
      version: snapshot.version,
      root: policyService.root,
      read: snapshot.fs.read.map(grant => ({ path: grant.path, recursive: grant.recursive })),
      write: snapshot.fs.write.map(grant => ({ path: grant.path, recursive: grant.recursive })),
      exec: [...snapshot.exec.allowPaths],
      network: {
        mode: snapshot.net.mode,
        allow: [...snapshot.net.allow],
        allowLocalBinding: snapshot.net.allowLocalBinding === true,
      },
    },
    // The IR never carries SBPL: the panel shows intent, not the mechanism.
    guards: policyService.listGuards().map(guard => ({
      id: guard.id,
      path: guard.path,
      match: guard.match,
      access: guard.access,
      reason: guard.reason,
      ...(guard.owner ? { owner: guard.owner } : {}),
    })),
    denials: {
      total: denial.recent(1_000).length,
      counts: denial.counts(),
      recent: recent.map(entry => ({
        id: entry.id,
        kind: entry.kind,
        target: entry.target,
        guard: entry.guard,
        evidence: entry.evidence,
        confidence: entry.confidence,
        repeated: entry.repeated,
        command: entry.command,
        at: entry.at,
        message: entry.message,
      })),
    },
    escalation: {
      mode: escalation?.modeFor(sessionId) ?? 'auto',
      sessionGrants: escalation?.listGrants() ?? [],
      relaxability: escalation?.relaxability() ?? [],
    },
  }
}

/** The subset of ServerResponse the panel needs. */
export interface StatusResponse {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body: string): unknown
}

/** Minimal request shape, so the panel can be exercised without a socket. */
export interface SandboxRequest {
  method?: string
  /** Pre-parsed body for tests; the HTTP route leaves this unset. */
  body?: unknown
  /** The real stream when the request arrives over HTTP. */
  stream?: IncomingMessage
}

export function json(res: StatusResponse, status: number, data: unknown) {
  sendJson(res as unknown as Parameters<typeof sendJson>[0], status, data)
}

async function bodyOf(req: SandboxRequest): Promise<any> {
  // Tests pass a parsed body; the HTTP route passes the IncomingMessage itself
  // (its `method` plus a readable stream), so fall back to the request.
  if (req.body !== undefined) return req.body
  const stream = req.stream ?? req as unknown as IncomingMessage
  if (typeof (stream as IncomingMessage)?.on === 'function') return readJson(stream)
  return {}
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean`)
  return value
}

function stringList(value: unknown, field: string, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array`)
  if (value.length > limit) throw new HttpError(400, `${field} has too many entries (max ${limit})`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new HttpError(400, `${field} must contain strings`)
    const text = item.trim()
    if (!text) continue
    if (text.length > maxLength) throw new HttpError(400, `${field} entry is too long`)
    result.push(text)
  }
  return [...new Set(result)]
}

function domainList(value: unknown): string[] {
  const entries = stringList(value, 'network.allowedDomains', 300, 200)
  for (const entry of entries) {
    if (entry === '*') continue
    if (!/^(\*\.)?[a-z0-9][a-z0-9.-]*(:\d{1,5})?$/i.test(entry)) {
      throw new HttpError(400, `invalid domain: ${entry}`)
    }
  }
  return entries
}

/** Validate a partial settings patch; unknown fields are ignored. */
export function sandboxPatch(body: any): SandboxSettings {
  const patch: SandboxSettings = {}
  if (body?.enabled !== undefined) patch.enabled = booleanField(body.enabled, 'enabled')
  if (body?.autoAllowBashIfSandboxed !== undefined) {
    patch.autoAllowBashIfSandboxed = booleanField(body.autoAllowBashIfSandboxed, 'autoAllowBashIfSandboxed')
  }
  if (body?.allowUnsandboxedCommands !== undefined) {
    patch.allowUnsandboxedCommands = booleanField(body.allowUnsandboxedCommands, 'allowUnsandboxedCommands')
  }
  if (body?.excludedCommands !== undefined) {
    patch.excludedCommands = stringList(body.excludedCommands, 'excludedCommands', 100, 200)
  }
  if (body?.network !== undefined) {
    if (!body.network || typeof body.network !== 'object') {
      throw new HttpError(400, 'network must be an object')
    }
    const network: NonNullable<SandboxSettings['network']> = {}
    if (body.network.allowedDomains !== undefined) network.allowedDomains = domainList(body.network.allowedDomains)
    if (body.network.allowLocalBinding !== undefined) {
      network.allowLocalBinding = booleanField(body.network.allowLocalBinding, 'network.allowLocalBinding')
    }
    patch.network = network
  }
  if (body?.filesystem !== undefined) {
    if (!body.filesystem || typeof body.filesystem !== 'object') {
      throw new HttpError(400, 'filesystem must be an object')
    }
    const filesystem: NonNullable<SandboxSettings['filesystem']> = {}
    if (body.filesystem.allowWrite !== undefined) {
      filesystem.allowWrite = stringList(body.filesystem.allowWrite, 'filesystem.allowWrite', 50, 500)
    }
    patch.filesystem = filesystem
  }
  return patch
}

async function handle(ctx: Context, req: SandboxRequest, res: StatusResponse, url: URL) {
  const sessionId = url.searchParams.get('sessionId') ?? ''

  if (url.pathname === '/api/sandbox/status') {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    json(res, 200, { status: await statusOf(ctx, sessionId) })
    return true
  }

  if (url.pathname === '/api/sandbox/config') {
    const settings = ctx.get('settings', false) as SettingsService | undefined
    const shell = ctx.get('shell', false) as ShellService | undefined
    if (!settings) throw new HttpError(404, 'settings service is not loaded')
    if (req.method === 'GET') {
      json(res, 200, { settings: sandboxConfigOf(ctx), executors: shell?.ids() ?? [] })
      return true
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await bodyOf(req)
      const patch = sandboxPatch(body)
      if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to update')
      // Turning the sandbox off is only possible when the escape hatch exists;
      // otherwise the next command would fail closed anyway.
      if (patch.enabled === false && !shell?.ids().includes('direct')) {
        throw new HttpError(409, 'direct executor is not mounted')
      }
      await settings.update({ sandbox: patch })
      json(res, 200, { settings: sandboxConfigOf(ctx) })
      return true
    }
    throw new HttpError(405, 'method not allowed')
  }

  if (url.pathname === '/api/sandbox/session') {
    if (req.method === 'GET') {
      json(res, 200, { sessionId, mode: escalationOf(ctx)?.modeFor(sessionId) ?? 'auto' })
      return true
    }
    if (req.method === 'PATCH') {
      const body = await bodyOf(req)
      const mode = body?.mode
      if (mode !== 'auto' && mode !== 'never') {
        throw new HttpError(400, 'mode must be "auto" or "never"')
      }
      // Session-scoped and in memory: a restart must not inherit a weakened
      // sandbox, so this never reaches settings.
      const escalation = escalationOf(ctx)
      if (!escalation) throw new HttpError(404, 'escalation service is not loaded')
      escalation.setMode(sessionId, mode)
      json(res, 200, { sessionId, mode })
      return true
    }
    throw new HttpError(405, 'method not allowed')
  }

  if (url.pathname === '/api/sandbox/grants') {
    const escalation = escalationOf(ctx)
    if (!escalation) throw new HttpError(404, 'escalation service is not loaded')
    if (req.method === 'DELETE') {
      json(res, 200, { revoked: escalation.clearGrants() })
      return true
    }
    if (req.method === 'GET') {
      json(res, 200, { grants: escalation.listGrants() })
      return true
    }
    throw new HttpError(405, 'method not allowed')
  }

  throw new HttpError(404, 'not found')
}

/**
 * Transport-free request handler.
 *
 * Exported so the whole surface can be tested without binding a socket: the
 * harness' own shell runs inside Seatbelt, which denies `listen`. Keeping the
 * logic here means the sandbox can verify its own status panel.
 */
export function createHandler(ctx: Context) {
  return async (req: SandboxRequest, res: StatusResponse, url: URL) => {
    try {
      return await handle(ctx, req, res, url)
    } catch (error) {
      if (error instanceof HttpError) {
        json(res, error.status, { error: error.message })
        return true
      }
      ctx.logger('sandbox-web').error(error)
      sendJson(res as ServerResponse, 500, { error: 'sandbox status unavailable' })
      return true
    }
  }
}

export function apply(ctx: Context) {
  const handler = createHandler(ctx)
  ctx.effect(() => ctx.web.register({
    prefix: '/api/sandbox',
    handler: (req, res, url) => handler(req as unknown as SandboxRequest, res, url),
  }), 'sandbox-web.routes')
}

export default { name, inject, apply }

export const meta = {
  title: '沙箱状态面板',
  description: 'Seatbelt 生效状态、守卫清单、拒绝时间线与会话级开关。',
}
