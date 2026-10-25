import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'
import type { SandboxService } from '@ruobai/sandbox'
import type { DenialService } from '@ruobai/sandbox-denial'
import type { EscalationService } from '@ruobai/sandbox-escalation'
import type { SandboxPolicyService } from '@ruobai/sandbox-policy'

export const name = 'sandbox-web'
export const inject = ['web', 'sandbox', 'sandboxPolicy', 'denial']

/**
 * Status projection for the sandbox.
 *
 * Deliberately read-mostly: the only write is a *session-scoped* escalation
 * switch. Policy editing (guards, network mode, write roots) is not exposed
 * over HTTP — see docs/sandbox-macos.md §7 for why it belongs in a reviewed
 * file rather than a click.
 */
export interface SandboxStatus {
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
  policy: {
    version: number
    root: string
    read: Array<{ path: string; recursive: boolean }>
    write: Array<{ path: string; recursive: boolean }>
    exec: string[]
    network: { mode: string; allow: unknown[] }
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

function statusOf(ctx: Context, sessionId: string): SandboxStatus {
  const sandbox = ctx.get('sandbox') as SandboxService
  const policyService = ctx.get('sandboxPolicy') as SandboxPolicyService
  const denial = ctx.get('denial') as DenialService
  const escalation = escalationOf(ctx)

  const provider = sandbox.provider()
  const snapshot = policyService.forSession({ sessionId })
  const recent = denial.recent()

  return {
    active: Boolean(provider),
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
      network: { mode: snapshot.net.mode, allow: [...snapshot.net.allow] },
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

async function handle(ctx: Context, req: SandboxRequest, res: StatusResponse, url: URL) {
  const sessionId = url.searchParams.get('sessionId') ?? ''

  if (url.pathname === '/api/sandbox/status') {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    json(res, 200, { status: statusOf(ctx, sessionId) })
    return true
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
