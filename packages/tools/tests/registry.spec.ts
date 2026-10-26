import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ToolRegistry from '../src/index.ts'

const cleanups: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!.dispose()
})

describe('tool registry', () => {
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
