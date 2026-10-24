import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import AgentService from '@ruobai/agent'
import type { ChatSession } from '@ruobai/chat-protocol'
import LlmService from '@ruobai/llm'
import MockProvider from '@ruobai/llm-mock'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import FsTools from '@ruobai/tool-fs'
import ChatService from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup(delay = 0) {
  const ctx = new Context()
  const llm = ctx.plugin(LlmService, { provider: 'mock', model: 'mock-1' })
  await llm
  const mock = ctx.plugin(MockProvider, { delay })
  await mock
  const sessions = ctx.plugin(SessionService)
  await sessions
  const tools = ctx.plugin(ToolRegistry)
  await tools
  const fsTools = ctx.plugin(FsTools, { root: process.cwd() })
  await fsTools
  const agent = ctx.plugin(AgentService, { maxSteps: 4 })
  await agent
  const chat = ctx.plugin(ChatService)
  await chat

  cleanups.push(
    () => chat.dispose(),
    () => agent.dispose(),
    () => fsTools.dispose(),
    () => tools.dispose(),
    () => sessions.dispose(),
    () => mock.dispose(),
    () => llm.dispose(),
  )
  return ctx
}

function nextDone(ctx: Context) {
  return new Promise<ChatSession>((resolve) => {
    ctx.on('chat/event', (event) => {
      if (event.type === 'message-done') resolve(event.session)
    })
  })
}

describe('chat bridge', () => {
  it('projects a streamed assistant reply into the UI model', async () => {
    const ctx = await setup()
    const session = ctx.chat.create()
    const done = nextDone(ctx)

    const user = ctx.chat.send(session.id, '你好')
    expect(user.role).toBe('user')

    const final = await done
    expect(final.streaming).toBe(false)
    expect(final.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(final.messages[1]?.blocks.some(block => block.type === 'text' && block.text.length > 0)).toBe(true)

    const summary = ctx.chat.list()[0]!
    expect(summary.title).toBe('你好')
    expect(summary.messageCount).toBe(2)
  })

  it('runs a tool call and attaches the result to the tool block', async () => {
    const ctx = await setup()
    const session = ctx.chat.create('tools')
    const done = nextDone(ctx)

    ctx.chat.send(session.id, '看一下文件')
    const final = await done

    const assistants = final.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(2)

    const tool = final.messages
      .flatMap(message => message.blocks)
      .find(block => block.type === 'tool')
    expect(tool?.type).toBe('tool')
    if (tool?.type === 'tool') {
      expect(tool.name).toBe('read_file')
      expect(tool.isError).toBe(false)
      expect(tool.output).toContain('"name"')
    }
  })

  it('stops a running turn', async () => {
    const ctx = await setup(15)
    const session = ctx.chat.create('stop')
    const done = nextDone(ctx)
    ctx.on('agent/step-start', () => ctx.chat.stop(session.id))

    ctx.chat.send(session.id, '写一段很长的话')
    const final = await done
    expect(final.streaming).toBe(false)
  })
})
