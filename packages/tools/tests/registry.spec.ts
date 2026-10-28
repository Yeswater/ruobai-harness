import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import ToolRegistry from '../src/index.ts'

const cleanups: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!.dispose()
})

describe('tool registry', () => {
  it('carries images returned by a tool through invoke', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(ToolRegistry)
    await fiber
    cleanups.push(fiber)

    ctx.tools.register({
      name: 'shot',
      description: 'shot',
      parameters: { type: 'object', properties: {} },
      execute: () => ({
        text: 'captured',
        images: [{ mimeType: 'image/png', data: 'QUJD', name: 'shot.png' }],
      }),
    })

    const result = await ctx.tools.invoke('shot', {})
    expect(result).toMatchObject({
      content: 'captured',
      isError: false,
      images: [{ mimeType: 'image/png', data: 'QUJD', name: 'shot.png' }],
    })
  })

  it('answers image capability without injecting sessions', async () => {
    const ctx = new Context()
    const registry = ctx.plugin(ToolRegistry)
    const sessions = ctx.plugin(SessionService)
    await registry
    await sessions
    cleanups.push(registry, sessions)

    const session = ctx.sessions.create({ provider: 'openai', model: 'x' })
    // Throws "without inject" before the fix; unknown because no settings.
    expect(ctx.tools.imageSupport(session.id)).toBe('unknown')
    expect(ctx.tools.imageSupport()).toBe('unknown')
  })

  it('renders tools in name order regardless of registration order', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(ToolRegistry)
    await fiber
    cleanups.push(fiber)

    for (const name of ['zebra', 'alpha', 'mcp__server__tool', 'bash']) {
      ctx.tools.register({
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        execute: () => name,
      })
    }

    expect(ctx.tools.list().map(tool => tool.name))
      .toEqual(['alpha', 'bash', 'mcp__server__tool', 'zebra'])
  })
})
