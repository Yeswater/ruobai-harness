import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import ShellService, { ShellUnavailableError, type ShellExecutor, type ShellRunSpec } from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function spec(overrides: Partial<ShellRunSpec> = {}): ShellRunSpec {
  return {
    command: 'echo hi',
    cwd: '/tmp',
    root: '/tmp',
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    ...overrides,
  }
}

function executor(id: string): ShellExecutor {
  return {
    id,
    async run(input) {
      return {
        content: `${id}:${input.command}`,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        truncated: false,
        denials: [],
        executor: id,
      }
    },
  }
}

async function setup() {
  const ctx = new Context()
  const fiber = ctx.plugin(ShellService)
  await fiber
  cleanups.push(() => fiber.dispose())
  return { ctx, fiber }
}

describe('ShellService', () => {
  it('fails closed with no executor registered', async () => {
    const { ctx } = await setup()
    await expect(ctx.shell.run(spec())).rejects.toBeInstanceOf(ShellUnavailableError)
  })

  it('runs the default executor and reports which one ran', async () => {
    const { ctx } = await setup()
    cleanups.push(ctx.shell.register(executor('direct'), { default: true }))
    expect((await ctx.shell.run(spec())).executor).toBe('direct')
  })

  it('keeps the first executor as default unless told otherwise', async () => {
    const { ctx } = await setup()
    cleanups.push(ctx.shell.register(executor('a')))
    cleanups.push(ctx.shell.register(executor('b')))
    expect((await ctx.shell.run(spec())).executor).toBe('a')
    cleanups.push(ctx.shell.register(executor('c'), { default: true }))
    expect((await ctx.shell.run(spec())).executor).toBe('c')
  })

  it('rejects duplicate ids', async () => {
    const { ctx } = await setup()
    cleanups.push(ctx.shell.register(executor('a')))
    expect(() => ctx.shell.register(executor('a'))).toThrow(/already registered/)
  })

  it('drops the executor when its disposer runs, and fails closed again', async () => {
    const { ctx } = await setup()
    const dispose = ctx.shell.register(executor('a'), { default: true })
    dispose()
    expect(ctx.shell.ids()).toEqual([])
    await expect(ctx.shell.run(spec())).rejects.toBeInstanceOf(ShellUnavailableError)
  })

  it('promotes the next executor when the default goes away', async () => {
    const { ctx } = await setup()
    const disposeA = ctx.shell.register(executor('a'), { default: true })
    cleanups.push(ctx.shell.register(executor('b')))
    disposeA()
    expect((await ctx.shell.run(spec())).executor).toBe('b')
  })

  it('emits before/after around the run', async () => {
    const { ctx } = await setup()
    cleanups.push(ctx.shell.register(executor('a'), { default: true }))
    const seen: string[] = []
    ctx.on('shell/before', () => seen.push('before'))
    ctx.on('shell/after', () => seen.push('after'))
    await ctx.shell.run(spec())
    expect(seen).toEqual(['before', 'after'])
  })

  it('clears the registry when the service unloads', async () => {
    const { ctx, fiber } = await setup()
    const service = ctx.shell
    ctx.shell.register(executor('a'), { default: true })
    await fiber.dispose()
    expect(service.ids()).toEqual([])
  })
})
