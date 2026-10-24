import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function fakeOpenAi() {
  let authorization: string | undefined
  let model: string | undefined

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const parsed = JSON.parse(body)
    model = parsed.model
    authorization = req.headers.authorization

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    })
    res.write('data: {"choices":[{"delta":{"content":"hello from fake"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.end('data: [DONE]\n\n')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { baseUrl, seen: () => ({ authorization, model }) }
}

describe('llm catalog', () => {
  it('registers a settings provider and serves a real chat turn through it', async () => {
    const harness = await createHarness()
    cleanups.push(() => harness.dispose())
    const { baseUrl, seen } = await fakeOpenAi()

    const settings = await harness.ctx.settings.upsertProvider({
      name: 'Fake',
      baseUrl,
      apiKey: 'sk-test',
      models: ['fake-model'],
    })
    const provider = settings.llm!.providers.find(item => item.name === 'Fake')!
    expect(harness.ctx.llm.get(provider.id)).toBeTruthy()

    const web = harness.ctx.web.url
    const created = await (await fetch(`${web}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).json() as { session: ChatSession }
    expect(created.session.model).toBe('fake-model')

    const done = new Promise<ChatSession>((resolve) => {
      harness.ctx.on('chat/event', (event) => {
        if (event.type === 'message-done') resolve(event.session)
      })
    })

    await fetch(`${web}/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })

    const final = await done
    const assistant = final.messages.find(message => message.role === 'assistant')
    const text = assistant?.blocks.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('hello from fake')
    expect(seen().authorization).toBe('Bearer sk-test')
    expect(seen().model).toBe('fake-model')

    await harness.ctx.settings.removeProvider(provider.id)
    expect(harness.ctx.llm.get(provider.id)).toBeUndefined()
  })
})
