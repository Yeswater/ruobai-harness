import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import { textOf, type LlmProvider, type ModelRequest, type StreamChunk } from '@ruobai/llm'

export interface Config {
  /** Milliseconds between streamed chunks. */
  delay?: number
  /** Fixed reply used for non-tool prompts. */
  reply?: string
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

function chunks(text: string) {
  const result: string[] = []
  for (let index = 0; index < text.length; index += 3) result.push(text.slice(index, index + 3))
  return result
}

/** Offline provider used for development and tests: deterministic, no network. */
export class MockProvider implements LlmProvider {
  name = 'mock'
  models = ['mock-1']

  constructor(private readonly config: Config = {}) {}

  async *stream(request: ModelRequest): AsyncIterable<StreamChunk> {
    const last = [...request.messages].reverse().find(item => item.role === 'user')
    const input = last ? textOf(last) : ''
    const delay = this.config.delay ?? 40

    try {
      const last = request.messages.at(-1)
      if (last?.role === 'tool') {
        const result = last.content.find(part => part.type === 'tool-result')
        const summary = result?.type === 'tool-result' ? result.content.slice(0, 400) : ''
        for (const chunk of chunks('工具已经返回结果，我来整理一下要点。')) {
          if (request.signal?.aborted) {
            yield { type: 'done', reason: 'aborted' }
            return
          }
          yield { type: 'reasoning-delta', text: chunk }
          await sleep(delay, request.signal)
        }
        const reply = `工具返回了结果：\n\n${summary}\n\n这是 mock 提供方的总结。接入真实模型后，这里会由模型根据工具结果继续回答。`
        for (const chunk of chunks(reply)) {
          if (request.signal?.aborted) {
            yield { type: 'done', reason: 'aborted' }
            return
          }
          yield { type: 'text-delta', text: chunk }
          await sleep(delay, request.signal)
        }
        yield { type: 'done', reason: 'stop' }
        return
      }

      if (/文件|代码|源码|file|read|查看|list/i.test(input)) {
        const tool = /目录|list/i.test(input) ? 'list_dir' : 'read_file'
        for (const chunk of chunks('用户想看文件，先确认一下要读取哪个路径。')) {
          if (request.signal?.aborted) {
            yield { type: 'done', reason: 'aborted' }
            return
          }
          yield { type: 'reasoning-delta', text: chunk }
          await sleep(delay, request.signal)
        }
        yield { type: 'text-delta', text: '我先读取一下相关文件。' }
        await sleep(delay, request.signal)
        yield {
          type: 'tool-call',
          id: `call_${Date.now().toString(36)}`,
          name: tool,
          arguments: JSON.stringify({ path: tool === 'list_dir' ? '.' : 'package.json' }),
        }
        yield { type: 'done', reason: 'tool-calls' }
        return
      }

      const reply = this.config.reply
        ?? `你好，我是 mock-1。收到：「${input}」。接入真实提供方后，这里会换成模型的流式输出。`
      for (const chunk of chunks(reply)) {
        if (request.signal?.aborted) {
          yield { type: 'done', reason: 'aborted' }
          return
        }
        yield { type: 'text-delta', text: chunk }
        await sleep(delay, request.signal)
      }
      yield { type: 'done', reason: 'stop' }
    } catch {
      yield { type: 'done', reason: 'aborted' }
    }
  }
}

/** Registers the offline `mock` provider. */
export default class MockProviderPlugin {
  static inject = ['llm']

  static Config: z<Config> = z.object({
    delay: z.number().min(0).default(40),
    reply: z.string(),
  })

  constructor(ctx: Context, config: Config) {
    ctx.effect(() => ctx.llm.register(new MockProvider(config)), 'ctx.llm.register(mock)')
  }
}

export const meta = {
  title: '离线模型',
  description: '无需网络的开发与测试模型。',
}
