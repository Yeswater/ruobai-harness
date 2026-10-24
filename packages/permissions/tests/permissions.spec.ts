import { afterEach, describe, expect, it } from 'vitest'
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
