import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import type { LlmProvider } from '@ruobai/llm'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []
const files: string[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
  while (files.length) await rm(files.pop()!, { force: true })
})

function nextDone(ctx: Harness['ctx']) {
  return new Promise<ChatSession>((resolve) => {
    ctx.on('chat/event', (event) => {
      if (event.type === 'message-done') resolve(event.session)
    })
  })
}

async function useScripted(ctx: Harness['ctx'], provider: LlmProvider) {
  ctx.effect(() => ctx.llm.register(provider))
  await ctx.settings.update({ llm: { activeProvider: 'scripted', activeModel: 'scripted-1' } })
}

function writeTool(path: string, content: string) {
  return {
    type: 'tool-call' as const,
    id: 'call_write',
    name: 'write_file',
    arguments: JSON.stringify({ path, content }),
  }
}

describe('agent modes', () => {
  it('Ask mode filters write tools and rejects a direct write call', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const seenTools: string[][] = []
    const file = 'ask-mode-test.txt'
    files.push(join(process.cwd(), file))

    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream(request) {
        seenTools.push((request.tools ?? []).map(tool => tool.name))
        if (seenTools.length === 1) {
          yield writeTool(file, 'nope')
          yield { type: 'done', reason: 'tool-calls' }
        } else {
          yield { type: 'text-delta', text: 'Ask mode will not modify files.' }
          yield { type: 'done', reason: 'stop' }
        }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'ask')
    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, 'write a file')
    const final = await done

    expect(seenTools[0]).not.toContain('write_file')
    const tool = final.messages.flatMap(message => message.blocks).find(block => block.type === 'tool')
    expect(tool?.type).toBe('tool')
    if (tool?.type === 'tool') {
      expect(tool.isError).toBe(true)
      expect(tool.output).toContain('not available')
    }
    await expect(readFile(join(process.cwd(), file), 'utf8')).rejects.toThrow()
  })

  it('Agent mode waits for approval before writing', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const file = 'approval-mode-test.txt'
    const target = join(process.cwd(), file)
    files.push(target)

    let step = 0
    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream() {
        step += 1
        if (step === 1) {
          yield writeTool(file, 'hello from approval')
          yield { type: 'done', reason: 'tool-calls' }
        } else {
          yield { type: 'text-delta', text: 'written' }
          yield { type: 'done', reason: 'stop' }
        }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const requested = new Promise<any>((resolve) => {
      harness.ctx.once('approval/requested', resolve)
    })
    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, 'write the file')

    const request = await requested
    expect(request.tool).toBe('write_file')
    expect(request.diff).toContain('+hello from approval')
    harness.ctx.approval.resolve(request.id, 'allow')

    await done
    expect(await readFile(target, 'utf8')).toBe('hello from approval')
    expect(step).toBe(2)
  })

  it('Goal mode nudges once and stops on goal_complete', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    let step = 0
    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream() {
        step += 1
        if (step === 1) {
          yield { type: 'text-delta', text: 'thinking' }
          yield { type: 'done', reason: 'stop' }
        } else {
          yield {
            type: 'tool-call',
            id: 'call_goal',
            name: 'goal_complete',
            arguments: JSON.stringify({ summary: 'done' }),
          }
          yield { type: 'done', reason: 'tool-calls' }
        }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'goal')
    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, 'finish the objective')
    const final = await done

    const tool = final.messages.flatMap(message => message.blocks).find(block => block.type === 'tool')
    expect(tool?.type).toBe('tool')
    if (tool?.type === 'tool') expect(tool.name).toBe('goal_complete')
    expect(step).toBe(2)
  })
})
