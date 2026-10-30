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

  async function startServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async function collect(baseUrl: string, config: Record<string, unknown> = {}, signal?: AbortSignal) {
    const ctx = new Context()
    const llm = ctx.plugin(LlmService, { provider: 'openai', model: 'test-model' })
    await llm
    const provider = ctx.plugin(OpenAiProvider, { baseUrl, model: 'test-model', ...config })
    await provider
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...(signal ? { signal } : {}),
    }, 'openai')) {
      chunks.push(chunk)
    }
    await provider.dispose()
    await llm.dispose()
    return chunks
  }

  it('reports a stalled stream as a timeout error instead of a fake done', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // Headers arrive, then nothing: this is the failure the old total timeout
      // turned into `done: aborted`, which persisted half a thought.
    })

    const chunks = await collect(baseUrl, { idleTimeoutMs: 40, maxRetries: 0 })

    expect(chunks).toContainEqual(expect.objectContaining({ type: 'error', code: 'timeout' }))
    expect(chunks.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
    expect(chunks).not.toContainEqual({ type: 'done', reason: 'aborted' })
  })

  it('keeps a streaming response alive past the idle window', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      let sent = 0
      const timer = setInterval(() => {
        sent += 1
        res.write(`data: {"choices":[{"delta":{"content":"t${sent}"}}]}\n\n`)
        if (sent === 4) {
          clearInterval(timer)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }, 30)
    })

    // The idle timer resets on every chunk; a slow stream is not a stalled one.
    const chunks = await collect(baseUrl, { idleTimeoutMs: 80, maxRetries: 0 })

    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(4)
    expect(chunks.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
  })

  it('retries a transient 5xx before giving up', async () => {
    let hits = 0
    const baseUrl = await startServer((_req, res) => {
      hits += 1
      if (hits === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'overloaded' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })

    const chunks = await collect(baseUrl, { maxRetries: 1, retryDelayMs: 1 })

    expect(hits).toBe(2)
    expect(chunks).toContainEqual({ type: 'text-delta', text: 'ok' })
    expect(chunks.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
  })

  it('does not retry after content already reached the caller', async () => {
    let hits = 0
    const baseUrl = await startServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"half"}}]}\n\n')
      setTimeout(() => res.socket?.destroy(), 10)
    })

    const chunks = await collect(baseUrl, { idleTimeoutMs: 5_000, maxRetries: 2, retryDelayMs: 1 })

    // Replaying would duplicate "half"; the failure has to surface instead.
    expect(hits).toBe(1)
    expect(chunks).toContainEqual({ type: 'text-delta', text: 'half' })
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(true)
  })

  it('reports a caller abort as an aborted stop', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)

    const chunks = await collect(baseUrl, { idleTimeoutMs: 5_000, maxRetries: 2 }, controller.signal)

    expect(chunks).toEqual([{ type: 'done', reason: 'aborted' }])
  })
})
