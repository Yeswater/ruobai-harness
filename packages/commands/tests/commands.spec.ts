import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import CommandService from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(() => sessions.dispose())
  const commands = ctx.plugin(CommandService)
  await commands
  cleanups.push(() => commands.dispose())
  const session = ctx.sessions.create({ title: 'commands' })
  return { ctx, sessionId: session.id }
}

describe('commands', () => {
  it('runs a registered command and records a notice', async () => {
    const { ctx, sessionId } = await setup()
    const seen: string[] = []
    cleanups.push(ctx.commands.register({
      name: 'demo',
      description: 'demo command',
      run: ({ args }) => {
        seen.push(args)
        return 'done'
      },
    }))
    ctx.sessions.append(sessionId, 'message/user', { text: '/demo hello world' })

    expect(await ctx.commands.dispatch(sessionId)).toBe(true)
    expect(seen).toEqual(['hello world'])
    const notice = ctx.sessions.get(sessionId)!.events.find(event => event.type === 'turn/notice')
    expect(notice?.data).toMatchObject({ kind: 'command', command: 'demo', message: 'done' })
  })

  it('leaves unknown commands and ordinary messages alone', async () => {
    const { ctx, sessionId } = await setup()
    ctx.sessions.append(sessionId, 'message/user', { text: '/nothing here' })
    expect(await ctx.commands.dispatch(sessionId)).toBe(false)

    ctx.sessions.append(sessionId, 'message/user', { text: '普通消息' })
    expect(await ctx.commands.dispatch(sessionId)).toBe(false)
  })

  it('turns a command failure into a notice instead of throwing', async () => {
    const { ctx, sessionId } = await setup()
    cleanups.push(ctx.commands.register({
      name: 'boom',
      description: 'always fails',
      run: () => {
        throw new Error('exploded')
      },
    }))
    ctx.sessions.append(sessionId, 'message/user', { text: '/boom' })
    expect(await ctx.commands.dispatch(sessionId)).toBe(true)
    const notice = ctx.sessions.get(sessionId)!.events.find(event => event.type === 'turn/notice')
    expect(String(notice?.data?.message)).toContain('exploded')
  })

  it('rejects duplicate names and unregisters cleanly', async () => {
    const { ctx } = await setup()
    const off = ctx.commands.register({ name: 'demo', description: 'one', run: () => 'ok' })
    expect(() => ctx.commands.register({ name: 'demo', description: 'two', run: () => 'ok' })).toThrow()
    off()
    expect(ctx.commands.get('demo')).toBeUndefined()
    cleanups.push(ctx.commands.register({ name: 'demo', description: 'three', run: () => 'ok' }))
    expect(ctx.commands.get('demo')?.description).toBe('three')
  })
})
