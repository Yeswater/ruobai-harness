import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import PermissionService, { autoAllowSandboxedBash } from '../src/index.ts'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
})

async function setup() {
  const harness = await createHarness()
  harnesses.push(harness)
  return harness
}

describe('sandboxed bash auto-approval', () => {
  it('returns allow through the permission service only when the sandbox is usable', async () => {
    const ctx = new Context()
    class StubSettings extends Service {
      constructor(inner: Context) {
        super(inner, 'settings')
      }

      get() {
        return { sandbox: { autoAllowBashIfSandboxed: true } }
      }

      raw() {
        return {}
      }
    }
    class StubSandbox extends Service {
      constructor(inner: Context) {
        super(inner, 'sandbox')
      }

      provider() {
        return { available: true }
      }
    }
    const sessions = ctx.plugin(SessionService)
    await sessions
    const tools = ctx.plugin(ToolRegistry)
    await tools
    const settings = ctx.plugin(StubSettings)
    await settings
    const sandbox = ctx.plugin(StubSandbox)
    await sandbox
    const permissions = ctx.plugin(PermissionService)
    await permissions

    expect(ctx.permissions.approval('s', 'bash', { kind: 'command', value: 'pnpm test' }, {})).toBe('allow')
    expect(ctx.permissions.approval(
      's',
      'bash',
      { kind: 'command', value: 'curl https://example.com' },
      { dangerouslyDisableSandbox: true },
    )).toBeUndefined()
    expect(ctx.permissions.approval('s', 'bash', { kind: 'command', value: 'docker ps' }, {})).toBeUndefined()

    await permissions.dispose()
    await sandbox.dispose()
    await settings.dispose()
    await tools.dispose()
    await sessions.dispose()
  })

  it('allows a command that stays inside the sandbox', () => {
    expect(autoAllowSandboxedBash({
      sandbox: { autoAllowBashIfSandboxed: true },
      command: 'pnpm test',
      sandboxAvailable: true,
    })).toBe(true)
  })

  it('does not bypass a denial of the escape hatch', () => {
    expect(autoAllowSandboxedBash({
      sandbox: { autoAllowBashIfSandboxed: true },
      command: 'curl https://example.com',
      args: { dangerouslyDisableSandbox: true },
      sandboxAvailable: true,
    })).toBe(false)
  })

  it('respects the switch, excluded commands and an unavailable provider', () => {
    expect(autoAllowSandboxedBash({
      sandbox: { autoAllowBashIfSandboxed: false },
      command: 'ls',
      sandboxAvailable: true,
    })).toBe(false)
    expect(autoAllowSandboxedBash({
      sandbox: { excludedCommands: ['docker'] },
      command: 'docker ps',
      sandboxAvailable: true,
    })).toBe(false)
    expect(autoAllowSandboxedBash({
      sandbox: {},
      command: 'ls',
      sandboxAvailable: false,
    })).toBe(false)
    expect(autoAllowSandboxedBash({
      sandbox: { enabled: false },
      command: 'ls',
      sandboxAvailable: true,
    })).toBe(false)
  })
})

describe('permission presets', () => {
  it('defaults to workspace-write and persists the session preset', async () => {
    const { ctx } = await setup()
    const session = ctx.chat.create()
    expect(ctx.permissions.modeFor(session.id)).toBe('workspace-write')

    ctx.sessions.setPermission(session.id, 'read-only')
    expect(ctx.permissions.modeFor(session.id)).toBe('read-only')

    await ctx.settings.update({ agent: { defaultPermission: 'auto-review' } })
    const fresh = ctx.chat.create()
    expect(ctx.permissions.modeFor(fresh.id)).toBe('auto-review')
  })

  it('hides mutating tools in read-only mode', async () => {
    const { ctx } = await setup()
    const session = ctx.chat.create()
    ctx.sessions.setPermission(session.id, 'read-only')
    expect(ctx.permissions.allowsTool(session.id, ctx.tools.get('read_file'))).toBe(true)
    expect(ctx.permissions.allowsTool(session.id, ctx.tools.get('write_file'))).toBe(false)
    expect(ctx.permissions.allowsTool(session.id, ctx.tools.get('bash'))).toBe(false)
    expect(ctx.permissions.approval(session.id, 'write_file', { kind: 'path', value: 'a.txt' })).toBe('deny')
  })

  it('auto-allows in-workspace paths but not commands in workspace-write', async () => {
    const { ctx } = await setup()
    const session = ctx.chat.create()
    expect(ctx.permissions.approval(session.id, 'write_file', { kind: 'path', value: 'a.txt' })).toBe('allow')
    expect(ctx.permissions.approval(session.id, 'bash', { kind: 'command', value: 'pwd' })).toBeUndefined()
  })

  it('auto-review and full access allow, with the danger guard handled by approvals', async () => {
    const { ctx } = await setup()
    const session = ctx.chat.create()
    ctx.sessions.setPermission(session.id, 'auto-review')
    expect(ctx.permissions.approval(session.id, 'bash', { kind: 'command', value: 'rm -rf /tmp/x' })).toBe('allow')
    ctx.sessions.setPermission(session.id, 'full-access')
    expect(ctx.permissions.approval(session.id, 'bash', { kind: 'command', value: 'rm -rf /tmp/x' })).toBe('allow')
  })

  it('denies mutating tool calls in read-only mode', async () => {
    const { ctx } = await setup()
    const session = ctx.chat.create()
    ctx.sessions.setPermission(session.id, 'read-only')

    const read = await ctx.tools.invoke('read_file', { path: 'package.json' }, { sessionId: session.id })
    expect(read.isError).toBe(false)

    const write = await ctx.tools.invoke(
      'write_file',
      { path: 'read-only-denied.txt', content: 'nope' },
      { sessionId: session.id },
    )
    expect(write.isError).toBe(true)
    expect(write.content).toContain('read-only')
  })

  it('still confirms dangerous commands in auto-review but not in full access', async () => {
    const { ctx } = await setup()
    const session = ctx.chat.create()
    const input = {
      sessionId: session.id,
      tool: 'bash',
      args: { command: 'rm -rf /' },
      subject: { kind: 'command' as const, value: 'rm -rf /' },
      summary: 'dangerous',
    }

    ctx.sessions.setPermission(session.id, 'auto-review')
    const pending = ctx.approval.request(input)
    await new Promise(resolve => setTimeout(resolve, 10))
    const requests = ctx.approval.list(session.id)
    expect(requests).toHaveLength(1)
    ctx.approval.resolve(requests[0]!.id, 'deny')
    await expect(pending).resolves.toBe('deny')

    ctx.sessions.setPermission(session.id, 'full-access')
    await expect(ctx.approval.request(input)).resolves.toBe('allow')
  })
})
