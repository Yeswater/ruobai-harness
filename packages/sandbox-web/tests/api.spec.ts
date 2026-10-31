import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ApprovalService from '@ruobai/approval'
import SandboxService from '@ruobai/sandbox'
import DenialService from '@ruobai/sandbox-denial'
import SandboxPolicyService from '@ruobai/sandbox-policy'
import EscalationService from '@ruobai/sandbox-escalation'
import { createHandler, sandboxPatch, type SandboxRequest, type StatusResponse } from '../src/index.ts'

/**
 * The panel is exercised through `createHandler`, not over HTTP.
 *
 * Binding a socket is exactly what Seatbelt denies inside the harness, so an
 * HTTP test could never run where it matters most — the sandbox's own shell.
 */
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface SetupOptions {
  withEscalation?: boolean
}

function fakeResponse() {
  const captured = { status: 0, body: undefined as any }
  const res: StatusResponse = {
    writeHead(status) {
      captured.status = status
      return res
    },
    end(body) {
      captured.body = JSON.parse(String(body))
      return res
    },
  }
  return { res, captured }
}

async function call(
  handler: ReturnType<typeof createHandler>,
  method: string,
  path: string,
  body?: unknown,
) {
  const { res, captured } = fakeResponse()
  const url = new URL(`http://127.0.0.1${path}`)
  const req: SandboxRequest = body === undefined ? { method } : { method, body }
  await handler(req, res, url)
  return captured
}

async function setup(options: SetupOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rbh-sandbox-web-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()

  const sandbox = ctx.plugin(SandboxService)
  await sandbox
  const policy = ctx.plugin(SandboxPolicyService, { root, network: { mode: 'deny', allow: [] } })
  await policy
  const denial = ctx.plugin(DenialService)
  await denial
  cleanups.push(ctx.sandboxPolicy.registerGuard({
    id: 'git-dir',
    path: join(root, '.git'),
    match: 'subpath',
    access: 'write',
    reason: 'hooks 不得被写入',
  }))

  let escalation: { dispose(): Promise<void> } | undefined
  if (options.withEscalation !== false) {
    const approval = ctx.plugin(ApprovalService)
    await approval
    escalation = ctx.plugin(EscalationService, {})
    await escalation
    cleanups.push(() => approval.dispose())
  }

  cleanups.push(
    () => escalation?.dispose() ?? Promise.resolve(),
    () => denial.dispose(),
    () => policy.dispose(),
    () => sandbox.dispose(),
  )

  return { ctx, root, handler: createHandler(ctx), denial: ctx.denial }
}

describe('sandbox settings patch', () => {
  it('accepts domains, toggles and write roots', () => {
    expect(sandboxPatch({
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: true,
      excludedCommands: ['docker', 'docker'],
      network: { allowedDomains: ['example.com', '*.example.com', 'host.test:8080'], allowLocalBinding: false },
      filesystem: { allowWrite: ['~/.cache/probe'] },
    })).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: true,
      excludedCommands: ['docker'],
      network: { allowedDomains: ['example.com', '*.example.com', 'host.test:8080'], allowLocalBinding: false },
      filesystem: { allowWrite: ['~/.cache/probe'] },
    })
  })

  it('rejects malformed domains and non-boolean switches', () => {
    expect(() => sandboxPatch({ network: { allowedDomains: ['https://example.com'] } })).toThrow('invalid domain')
    expect(() => sandboxPatch({ enabled: 'yes' })).toThrow('must be a boolean')
    expect(() => sandboxPatch({ network: { allowedDomains: 'example.com' } })).toThrow('must be an array')
  })
})

describe('GET /api/sandbox/status', () => {
  it('reports an unavailable sandbox instead of pretending it works', async () => {
    const { handler } = await setup()
    const { status, body } = await call(handler, 'GET', '/api/sandbox/status')
    expect(status).toBe(200)
    expect(body.status.active).toBe(false)
    expect(body.status.unavailable).toContain('no sandbox provider')
  })

  it('lists the registered guards with their reason', async () => {
    const { handler } = await setup()
    const { body } = await call(handler, 'GET', '/api/sandbox/status')
    expect(body.status.guards).toHaveLength(1)
    expect(body.status.guards[0]).toMatchObject({
      id: 'git-dir',
      access: 'write',
      reason: 'hooks 不得被写入',
    })
  })

  it('exposes the policy as intent, never as SBPL', async () => {
    const { handler } = await setup()
    const { body } = await call(handler, 'GET', '/api/sandbox/status')
    const text = JSON.stringify(body.status.policy)
    expect(text).toContain('"mode":"deny"')
    // The panel must not leak the mechanism or the guard boundaries as SBPL.
    expect(text).not.toContain('subpath')
    expect(text).not.toContain('(deny')
  })

  it('summarises denials with kind, target, guard and confidence', async () => {
    const { handler, denial, root } = await setup()
    denial.classify({
      runId: 'r1',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
      truncated: false,
      // The target must match the registered guard path, otherwise the denial
      // is attributed to 'fs-write-outside' rather than the guard itself.
      denials: [{ pid: 7, operation: 'file-write-data', target: join(root, '.git', 'config'), at: Date.now() }],
      pids: [7],
    }, { command: 'echo x >> .git/config', sessionId: 's1' })

    const { body } = await call(handler, 'GET', '/api/sandbox/status')
    expect(body.status.denials.total).toBe(1)
    expect(body.status.denials.recent[0]).toMatchObject({ kind: 'fs-write-guarded' })
    expect(body.status.denials.counts['fs-write-guarded']).toBe(1)
  })

  it('defaults the session mode to auto and reports relaxability', async () => {
    const { handler } = await setup()
    const { body } = await call(handler, 'GET', '/api/sandbox/status?sessionId=s1')
    expect(body.status.escalation.mode).toBe('auto')
    const network = body.status.escalation.relaxability.find((entry: any) => entry.kind === 'network-outbound')
    expect(network.relaxable).toBe(false)
  })

  it('rejects an unknown route and method', async () => {
    const { handler } = await setup()
    expect((await call(handler, 'GET', '/api/sandbox/nope')).status).toBe(404)
    expect((await call(handler, 'POST', '/api/sandbox/status')).status).toBe(405)
  })
})

describe('PATCH /api/sandbox/session', () => {
  it('reads a PATCH body from the real request stream', async () => {
    // The web route hands the handler an IncomingMessage, not `{ body }`:
    // reading only the test shape made every PATCH answer 400 in production.
    const { ctx } = await setup()
    const handler = createHandler(ctx)
    const { res, captured } = fakeResponse()
    // A real IncomingMessage yields Buffers, not strings.
    const req = Object.assign(Readable.from([Buffer.from('{"mode":"never"}')]), { method: 'PATCH' })
    await handler(req as unknown as SandboxRequest, res, new URL('http://127.0.0.1/api/sandbox/session?sessionId=s1'))
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ sessionId: 's1', mode: 'never' })
  })

  it('sets and reads back the session switch', async () => {
    const { handler } = await setup()
    const patched = await call(handler, 'PATCH', '/api/sandbox/session?sessionId=s1', { mode: 'never' })
    expect(patched.status).toBe(200)
    const { body } = await call(handler, 'GET', '/api/sandbox/status?sessionId=s1')
    expect(body.status.escalation.mode).toBe('never')
  })

  it('keeps sessions independent', async () => {
    const { handler } = await setup()
    await call(handler, 'PATCH', '/api/sandbox/session?sessionId=s1', { mode: 'never' })
    const other = await call(handler, 'GET', '/api/sandbox/status?sessionId=s2')
    expect(other.body.status.escalation.mode).toBe('auto')
  })

  it('rejects an unknown mode', async () => {
    const { handler } = await setup()
    expect((await call(handler, 'PATCH', '/api/sandbox/session?sessionId=s1', { mode: 'off' })).status).toBe(400)
  })

  it('never persists the switch to settings', async () => {
    const { handler } = await setup()
    await call(handler, 'PATCH', '/api/sandbox/session?sessionId=s1', { mode: 'never' })
    // A fresh context starts from the safe default: nothing was written to disk
    // and nothing survives the process.
    const second = await setup()
    const { body } = await call(second.handler, 'GET', '/api/sandbox/status?sessionId=s1')
    expect(body.status.escalation.mode).toBe('auto')
  })

  it('fails closed when the escalation service is not mounted', async () => {
    const { handler } = await setup({ withEscalation: false })
    expect((await call(handler, 'PATCH', '/api/sandbox/session?sessionId=s1', { mode: 'never' })).status).toBe(404)
  })
})

describe('DELETE /api/sandbox/grants', () => {
  it('revokes session grants and reports how many', async () => {
    const { handler } = await setup()
    const { status, body } = await call(handler, 'DELETE', '/api/sandbox/grants')
    expect(status).toBe(200)
    expect(body.revoked).toBe(0)
  })
})

describe('degraded plugin sets', () => {
  it('still serves status without escalation', async () => {
    const { handler } = await setup({ withEscalation: false })
    const { status, body } = await call(handler, 'GET', '/api/sandbox/status')
    expect(status).toBe(200)
    expect(body.status.escalation.sessionGrants).toEqual([])
  })
})
