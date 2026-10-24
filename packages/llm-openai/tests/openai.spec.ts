import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import LlmService, { type StreamChunk } from '@ruobai/llm'
import OpenAiProvider from '../src/index.ts'

const servers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (servers.length) await servers.pop()!()
})

async function mockApi(frames: string[]) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const frame of frames) res.write(frame)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function captureApi(frames: string[]) {
  let body: any
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      body = JSON.parse(raw)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const frame of frames) res.write(frame)
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    captured: () => body,
  }
}

describe('openai adapter', () => {
  it('maps SSE text deltas', async () => {
    const baseUrl = await mockApi([
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])

    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'openai', model: 'test-model' })
    await llm
    const provider = ctx.plugin(OpenAiProvider, { baseUrl, model: 'test-model' })
    await provider

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, 'openai')) {
      chunks.push(chunk)
    }

    expect(chunks).toContainEqual({ type: 'text-delta', text: 'he' })
    expect(chunks).toContainEqual({ type: 'text-delta', text: 'llo' })
    expect(chunks.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })

    await provider.dispose()
    await llm.dispose()
  })

  it('accumulates streamed tool calls into one chunk', async () => {
    const baseUrl = await mockApi([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])

    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'openai', model: 'test-model' })
    await llm
    const provider = ctx.plugin(OpenAiProvider, { baseUrl, model: 'test-model' })
    await provider

    const completion = await ctx.llm.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }] }, 'openai')
    expect(completion.calls).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }])
    expect(completion.reason).toBe('tool-calls')

    await provider.dispose()
    await llm.dispose()
  })

  it('sends image and file parts and parses cached usage', async () => {
    const { baseUrl, captured } = await captureApi([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":6}}}\n\n',
      'data: [DONE]\n\n',
    ])

    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'openai', model: 'test-model' })
    await llm
    const provider = ctx.plugin(OpenAiProvider, { baseUrl, model: 'test-model' })
    await provider

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'file', name: 'a.txt', mimeType: 'text/plain', text: 'hi' },
        ],
      }],
    }, 'openai')) {
      chunks.push(chunk)
    }

    const content = captured().messages[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
    expect(content[2].text).toContain('<file name="a.txt">')
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 6 },
    })

    await provider.dispose()
    await llm.dispose()
  })
})
