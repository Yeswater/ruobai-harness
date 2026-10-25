import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import type { Message } from '@ruobai/llm'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const harnesses: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

function nextDone(ctx: Harness['ctx']) {
  return new Promise<ChatSession>((resolve) => {
    ctx.on('chat/event', (event) => {
      if (event.type === 'message-done') resolve(event.session)
    })
  })
}

async function workspaceWithSkill(body = 'review body') {
  const dir = await mkdtemp(join(tmpdir(), 'rbh-agent-skills-'))
  dirs.push(dir)
  await mkdir(join(dir, '.ruobai', 'skills', 'review'), { recursive: true })
  await writeFile(
    join(dir, '.ruobai', 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Review a change\n---\n\n${body}\n`,
  )
  return dir
}

async function useScripted(ctx: Harness['ctx'], seen: Message[][]) {
  ctx.effect(() => ctx.llm.register({
    name: 'scripted',
    async *stream(request) {
      seen.push(request.messages)
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'done', reason: 'stop' }
    },
  }))
  await ctx.settings.update({ llm: { activeProvider: 'scripted', activeModel: 'scripted-1' } })
}

describe('agent skill gestures', () => {
  it('injects a user-invocable skill once and hides it from the transcript', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const dir = await workspaceWithSkill()
    const seen: Message[][] = []
    await useScripted(harness.ctx, seen)

    const session = harness.ctx.chat.create(undefined, 'agent', dir)
    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, '/review check this')
    const final = await done

    const requestText = seen[0]!.map(message => typeof message.content === 'string'
      ? message.content
      : message.content.map(part => part.type === 'text' ? part.text : '').join(''))
      .join('\n')
    expect(requestText).toContain('<skill_content name="review"')
    expect(requestText).toContain('review body')

    const visible = final.messages.filter(message => message.role === 'user')
    expect(visible).toHaveLength(1)
    expect(JSON.stringify(visible[0]!.blocks)).toContain('/review check this')
    expect(JSON.stringify(final.messages)).not.toContain('<skill_content')
  })

  it('leaves unknown slashes as plain prose', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const dir = await workspaceWithSkill()
    const seen: Message[][] = []
    await useScripted(harness.ctx, seen)

    const session = harness.ctx.chat.create(undefined, 'agent', dir)
    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, '/unknown hello')
    await done

    const requestText = seen[0]!.map(message => typeof message.content === 'string'
      ? message.content
      : message.content.map(part => part.type === 'text' ? part.text : '').join(''))
      .join('\n')
    expect(requestText).not.toContain('<skill_content')
    expect(requestText).toContain('/unknown hello')
  })

  it('does not inject model-disabled skills for users', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const dir = await workspaceWithSkill()
    await mkdir(join(dir, '.ruobai', 'skills', 'secret'), { recursive: true })
    await writeFile(
      join(dir, '.ruobai', 'skills', 'secret', 'SKILL.md'),
      '---\nname: secret\ndescription: Hidden\nuser-invocable: false\n---\n\nsecret body\n',
    )
    const seen: Message[][] = []
    await useScripted(harness.ctx, seen)

    const session = harness.ctx.chat.create(undefined, 'agent', dir)
    const done = nextDone(harness.ctx)
    harness.ctx.chat.send(session.id, '/secret go')
    await done

    const requestText = seen[0]!.map(message => typeof message.content === 'string'
      ? message.content
      : message.content.map(part => part.type === 'text' ? part.text : '').join(''))
      .join('\n')
    expect(requestText).not.toContain('secret body')
  })
})
