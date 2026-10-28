import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function writeLaunch(dir: string, configurations: unknown) {
  await mkdir(join(dir, '.ruobai'), { recursive: true })
  await writeFile(join(dir, '.ruobai', 'launch.json'), JSON.stringify({ version: '0.0.1', configurations }, null, 2))
}

describe('preview servers', () => {
  it('starts a launch configuration, serves it and stops it', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const port = await freePort()
    const script = [
      "const http = require('node:http')",
      `http.createServer((req, res) => res.end('preview-ok')).listen(${port}, '127.0.0.1', () => console.log('fixture ready'))`,
    ].join('\n')
    await writeLaunch(dir, [{
      name: 'fixture',
      runtimeExecutable: process.execPath,
      runtimeArgs: ['-e', script],
      port,
      autoPort: false,
    }])

    const snapshot = await ctx.preview.snapshot()
    expect(snapshot.configurations.map(item => item.name)).toEqual(['fixture'])
    expect(snapshot.states[0]).toMatchObject({ status: 'stopped' })

    const started = await ctx.preview.start('fixture')
    expect(started).toMatchObject({ status: 'running', port, url: `http://127.0.0.1:${port}` })

    const response = await fetch(`http://127.0.0.1:${port}/`)
    expect(await response.text()).toBe('preview-ok')

    const logs = await ctx.preview.logs('fixture')
    expect(logs.logs.join('\n')).toContain('fixture ready')

    const stopped = await ctx.preview.stop('fixture')
    expect(stopped.status).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  }, 30_000)

  it('picks a free port when the configured one is taken', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const blocker = createServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const blocked = (blocker.address() as { port: number }).port
    try {
      await writeLaunch(dir, [{
        name: 'auto',
        runtimeExecutable: process.execPath,
        runtimeArgs: ['-e', "require('node:http').createServer((q,s)=>s.end('auto-ok')).listen(Number(process.env.PORT),'127.0.0.1')"],
        port: blocked,
      }])

      const started = await ctx.preview.start('auto')
      expect(started.status).toBe('running')
      expect(started.port).toBeDefined()
      expect(started.port).not.toBe(blocked)
      expect(await (await fetch(started.url!)).text()).toBe('auto-ok')
      const logs = await ctx.preview.logs('auto')
      expect(logs.logs.join('\n')).toContain(`port ${blocked} is in use; using`)
      await ctx.preview.stop('auto')
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }
  }, 30_000)

  it('never lets the parent PORT leak into the child', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const port = await freePort()
    const saved = process.env.PORT
    process.env.PORT = String(await freePort())
    try {
      await writeLaunch(dir, [{
        name: 'env',
        runtimeExecutable: process.execPath,
        runtimeArgs: ['-e', "require('node:http').createServer((q,s)=>s.end('env-ok')).listen(Number(process.env.PORT),'127.0.0.1')"],
        port,
        autoPort: false,
      }])
      const started = await ctx.preview.start('env')
      expect(started).toMatchObject({ status: 'running', port })
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('env-ok')
      await ctx.preview.stop('env')
    } finally {
      if (saved === undefined) delete process.env.PORT
      else process.env.PORT = saved
    }
  }, 30_000)

  it('fails with a reason when autoPort is disabled', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const blocker = createServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const blocked = (blocker.address() as { port: number }).port
    try {
      await writeLaunch(dir, [{
        name: 'strict',
        runtimeExecutable: process.execPath,
        runtimeArgs: ['-e', 'process.exit(0)'],
        port: blocked,
        autoPort: false,
      }])
      const state = await ctx.preview.start('strict')
      expect(state.status).toBe('failed')
      expect(state.error).toContain('already in use')
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }
  })

  it('reports invalid launch files instead of spawning', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    await writeLaunch(dir, [
      { name: 'dup', runtimeExecutable: 'node' },
      { name: 'dup', runtimeExecutable: 'node' },
    ])

    const snapshot = await ctx.preview.snapshot()
    expect(snapshot.error).toContain('duplicate configuration name')
    expect(snapshot.configurations).toEqual([])
    await expect(ctx.preview.start('dup')).rejects.toThrow(/duplicate/)
  })

  it('serves the snapshot and actions over HTTP', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness
    const port = await freePort()
    await writeLaunch(dir, [{
      name: 'fixture',
      runtimeExecutable: process.execPath,
      runtimeArgs: ['-e', `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')`],
      port,
    }])
    const base = ctx.web.url

    const listed = await (await fetch(`${base}/api/preview`)).json() as { configurations: Array<{ name: string }> }
    expect(listed.configurations).toHaveLength(1)

    const started = await (await fetch(`${base}/api/preview/fixture/start`, { method: 'POST' })).json() as {
      state: { status: string }
    }
    expect(started.state.status).toBe('running')

    const stopped = await (await fetch(`${base}/api/preview/fixture/stop`, { method: 'POST' })).json() as {
      state: { status: string }
    }
    expect(stopped.state.status).toBe('stopped')
  }, 30_000)
})
