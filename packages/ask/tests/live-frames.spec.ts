import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAskFrame } from '../../ui-app/src/api.ts'
import { createHarness, type Harness } from '../../../tests/harness.ts'

/**
 * The question card rides two downlinks. SSE hands the raw broadcast payload to
 * the named event; the WebSocket wraps everything `ui.broadcast` sends under
 * `data`. A client that only understands one shape shows no card at all, which
 * is exactly what happened: the socket won the race, and the card never
 * appeared even though the server had the question.
 *
 * These assertions pin the frame shape the browser has to parse.
 */

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function setup() {
  harness = await createHarness()
  const session = harness.ctx.sessions.create({ workspace: harness.dir })
  return { ctx: harness.ctx, sessionId: session.id }
}

function connect(url: string) {
  const socket = new WebSocket(url)
  const frames: unknown[] = []
  const ready = new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  socket.on('message', (data) => {
    frames.push(JSON.parse(String(data)))
  })
  return { socket, frames, ready }
}

async function waitFor(check: () => boolean, timeout = 3_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition was not met in time')
}

describe('ask frames', () => {
  it('reaches the browser over the WebSocket in the shape it parses', async () => {
    const { ctx, sessionId } = await setup()
    const live = connect(`${ctx.web.url.replace('http', 'ws')}/api/ws`)
    await live.ready

    const pending = ctx.tools.invoke('ask_user', {
      question: '要用哪套部署？',
      options: ['复用本地', '重装'],
    }, { sessionId })
    await waitFor(() => ctx.ask.list(sessionId).length === 1)
    await waitFor(() => live.frames.some(frame => (frame as { type: string }).type === 'ask'))

    const frame = live.frames.find(item => (item as { type: string }).type === 'ask')
    const parsed = parseAskFrame(frame)
    expect(parsed).toMatchObject({
      kind: 'requested',
      request: { sessionId, question: '要用哪套部署？', options: ['复用本地', '重装'] },
    })

    // Answering has to come back the same way, or the card never disappears.
    const [request] = ctx.ask.list(sessionId)
    ctx.ask.answer(request!.id, '复用本地')
    await pending
    await waitFor(() => live.frames.filter(item => (item as { type: string }).type === 'ask').length >= 2)

    const resolved = live.frames
      .filter(item => (item as { type: string }).type === 'ask')
      .map(parseAskFrame)
      .find(entry => entry?.kind === 'resolved')
    expect(resolved).toMatchObject({
      kind: 'resolved',
      resolution: { id: request!.id, via: 'option', answer: '复用本地' },
    })

    live.socket.close()
  })
})
