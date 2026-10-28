import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('tool images in the model view', () => {
  it('follows a tool result with a user message carrying the image', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const session = ctx.sessions.create({ workspace: dir })
    const at = Date.now()
    ctx.sessions.append(session.id, 'message/user', { id: 'u1', text: 'take a screenshot', at })
    ctx.sessions.append(session.id, 'message/assistant', {
      id: 'a1',
      at,
      parts: [{ type: 'tool-call', id: 'c1', name: 'browser_screenshot', arguments: '{}' }],
    })
    ctx.sessions.append(session.id, 'tool/result', {
      callId: 'c1',
      name: 'browser_screenshot',
      content: 'Screenshot: .ruobai/screenshots/a.png',
      isError: false,
      images: [{ mimeType: 'image/png', data: 'QUJD', name: '.ruobai/screenshots/a.png' }],
    })

    const built = await ctx.context.build(session.id, { basePrompt: 'base' })
    const toolIndex = built.messages.findIndex(message => message.role === 'tool')
    expect(toolIndex).toBeGreaterThanOrEqual(0)

    const imageMessage = built.messages[toolIndex + 1]
    expect(imageMessage?.role).toBe('user')
    expect(imageMessage?.content[0]).toMatchObject({ type: 'text' })
    const image = imageMessage?.content.find(part => part.type === 'image')
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'QUJD' })
  })

  it('places images after the whole tool-result run', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const session = ctx.sessions.create({ workspace: dir })
    const at = Date.now()
    ctx.sessions.append(session.id, 'message/user', { id: 'u1', text: 'two tools', at })
    ctx.sessions.append(session.id, 'message/assistant', {
      id: 'a1',
      at,
      parts: [
        { type: 'tool-call', id: 'c1', name: 'browser_screenshot', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'read_file', arguments: '{}' },
      ],
    })
    ctx.sessions.append(session.id, 'tool/result', {
      callId: 'c1', name: 'browser_screenshot', content: 'shot', isError: false,
      images: [{ mimeType: 'image/png', data: 'QUJD' }],
    })
    ctx.sessions.append(session.id, 'tool/result', {
      callId: 'c2', name: 'read_file', content: 'file', isError: false,
    })

    const built = await ctx.context.build(session.id, { basePrompt: 'base' })
    const roles = built.messages.map(message => message.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    const imageMessage = built.messages.at(-1)!
    expect(imageMessage.content.some(part => part.type === 'image')).toBe(true)
  })

  it('leaves a text-only tool result unchanged', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const session = ctx.sessions.create({ workspace: dir })
    const at = Date.now()
    ctx.sessions.append(session.id, 'message/user', { id: 'u1', text: 'go', at })
    ctx.sessions.append(session.id, 'message/assistant', {
      id: 'a1',
      at,
      parts: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }],
    })
    ctx.sessions.append(session.id, 'tool/result', {
      callId: 'c1',
      name: 'read_file',
      content: 'hello',
      isError: false,
    })

    const built = await ctx.context.build(session.id, { basePrompt: 'base' })
    const roles = built.messages.map(message => message.role)
    expect(roles.filter(role => role === 'tool')).toHaveLength(1)
    expect(built.messages.some(message => message.content.some(part => part.type === 'image'))).toBe(false)
  })
})
