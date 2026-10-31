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
    // Workspace-write auto-allows in-workspace paths; an explicit ask rule
    // keeps the human-approval path under test.
    await harness.ctx.settings.upsertApprovalRule({
      tool: 'write_file',
      match: 'glob',
      pattern: '**',
      action: 'ask',
    })
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

  it('keeps looping until the model stops calling tools', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    let step = 0
    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream() {
        step += 1
        if (step <= 12) {
          yield {
            type: 'tool-call',
            id: `call_${step}`,
            name: 'list_dir',
            arguments: JSON.stringify({ path: '.' }),
          }
          yield { type: 'done', reason: 'tool-calls' }
        } else {
          yield { type: 'text-delta', text: 'done' }
          yield { type: 'done', reason: 'stop' }
        }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, 'keep working')
    const final = await done

    expect(step).toBe(13)
    const texts = final.messages.flatMap(message => message.blocks)
      .filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text)
    expect(texts.join('\n')).not.toContain('步上限')
    expect(texts.join('\n')).toContain('done')
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

  it('Agent mode loads a deferred integration tool with tool_search', async () => {
    const harness = await createHarness()
    harnesses.push(harness)

    const seen: string[][] = []
    await useScripted(harness.ctx, {
      name: 'scripted',
      async *stream(request) {
        seen.push((request.tools ?? []).map(tool => tool.name))
        if (seen.length === 1) {
          yield {
            type: 'tool-call',
            id: 'call_search',
            name: 'tool_search',
            arguments: JSON.stringify({ query: 'gitee issue' }),
          }
          yield { type: 'done', reason: 'tool-calls' }
        } else {
          yield { type: 'text-delta', text: 'done' }
          yield { type: 'done', reason: 'stop' }
        }
      },
    })

    const session = harness.ctx.chat.create(undefined, 'agent')
    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, 'look at a gitee issue')
    await done

    expect(seen[0]).toContain('tool_search')
    expect(seen[0]).not.toContain('gitee_repo')
    expect(seen[1]).toContain('gitee_repo')
    // Ask mode names the read-only Gitee tools itself, so they stay visible there.
    expect(harness.ctx.modes.explicit('ask', 'gitee_repo')).toBe(true)
    expect(harness.ctx.modes.explicit('agent', 'gitee_repo')).toBe(false)
  })
})
