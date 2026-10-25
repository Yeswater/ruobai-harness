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

  it('maps streamed reasoning in both provider shapes', async () => {
    const baseUrl = await mockApi([
      'data: {"choices":[{"delta":{"reasoning_content":"先看看"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning":[{"text":"文件路径"}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好的"}}]}\n\n',
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

    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toEqual([
      { type: 'reasoning-delta', text: '先看看' },
      { type: 'reasoning-delta', text: '文件路径' },
    ])
    expect(chunks).toContainEqual({ type: 'text-delta', text: '好的' })

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
          { type: 'file', name: 'a.txt', path: 'src/a.txt', mimeType: 'text/plain', text: 'hi' },
        ],
      }],
    }, 'openai')) {
      chunks.push(chunk)
    }

    const content = captured().messages[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
    expect(content[2].text).toContain('<file name="a.txt" path="src/a.txt">')
    // Disjoint counts: prompt_tokens 10 includes the 6 cached, so 4 are uncached.
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 6 },
    })

    await provider.dispose()
    await llm.dispose()
  })

  it('reads usage from the trailing frame after finish_reason', async () => {
    const baseUrl = await mockApi([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":6}}}\n\n',
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

    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      reason: 'stop',
      usage: { inputTokens: 4, outputTokens: 4, cachedInputTokens: 6 },
    })

    await provider.dispose()
    await llm.dispose()
  })

  it('ignores a zero placeholder next to the real cache counter', async () => {
    const baseUrl = await mockApi([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":0},"prompt_cache_hit_tokens":80}}\n\n',
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

    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 80 },
    })

    await provider.dispose()
    await llm.dispose()
  })

  it('folds exclusive cache counters into the prompt instead of overflowing', async () => {
    const baseUrl = await mockApi([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":5,"prompt_cache_hit_tokens":800}}\n\n',
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

    // Cache reads beyond the prompt count are billed on top; the prompt stays
    // uncached, so the pair still adds up (200 + 800).
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 200, outputTokens: 5, cachedInputTokens: 800 },
    })

    await provider.dispose()
    await llm.dispose()
  })

  it('requests usage frames and retries without them when rejected', async () => {
    const bodies: any[] = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        const body = JSON.parse(raw)
        bodies.push(body)
        if (body.stream_options) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unknown field stream_options' } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'openai', model: 'test-model' })
    await llm
    const provider = ctx.plugin(OpenAiProvider, { baseUrl, model: 'test-model' })
    await provider

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, 'openai')) {
      chunks.push(chunk)
    }

    expect(bodies[0]?.stream_options).toEqual({ include_usage: true })
    expect(bodies[1]?.stream_options).toBeUndefined()
    expect(chunks).toContainEqual({ type: 'text-delta', text: 'ok' })

    await provider.dispose()
    await llm.dispose()
  })

  it('surfaces a structured context overflow code', async () => {
    const server = createServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: { code: 'context_length_exceeded', message: 'too long' },
      }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'openai', model: 'test-model' })
    await llm
    const provider = ctx.plugin(OpenAiProvider, { baseUrl, model: 'test-model' })
    await provider

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }, 'openai')) {
      chunks.push(chunk)
    }
    expect(chunks[0]).toMatchObject({ type: 'error', code: 'context_length_exceeded' })

    await provider.dispose()
    await llm.dispose()
  })
})
