import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined
const cleanups: Array<() => void> = []

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!()
  await harness?.dispose()
  harness = undefined
})

async function waitUntil(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

describe.skipIf(process.platform === 'win32')('terminal', () => {
  it('runs a shell and streams its output', async () => {
    harness = await createHarness()
    const { ctx } = harness

    const terminal = ctx.terminal.create({ cols: 80, rows: 24 })
    expect(terminal.alive).toBe(true)
    expect(terminal.cwd).toBe('.')

    const output: string[] = []
    cleanups.push(ctx.on('terminal/output', (_id, data) => output.push(data)))

    ctx.terminal.write(terminal.id, 'echo hello-pty\n')
    expect(await waitUntil(() => output.join('').includes('hello-pty'))).toBe(true)
    expect(ctx.terminal.buffer(terminal.id)).toContain('hello-pty')

    ctx.terminal.write(terminal.id, 'exit\n')
    expect(await waitUntil(() => !ctx.terminal.list()[0]!.alive)).toBe(true)
  }, 15_000)

  it('refuses cwd outside the root and exposes the HTTP surface', async () => {
    harness = await createHarness()
    const { ctx, dir } = harness

    expect(() => ctx.terminal.create({ cwd: '../outside' })).toThrow(/escapes/)

    const base = ctx.web.url
    const created = await (await fetch(`${base}/api/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '.', cols: 100, rows: 30 }),
    })).json() as { terminal: { id: string; cwd: string } }
    expect(created.terminal.cwd).toBe('.')

    await fetch(`${base}/api/terminal/${created.terminal.id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'pwd\n' }),
    })
    const encoded = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    expect(await waitUntil(() => new RegExp(encoded).test(ctx.terminal.buffer(created.terminal.id) ?? ''))).toBe(true)

    const buffer = await (await fetch(`${base}/api/terminal/${created.terminal.id}/buffer`)).json() as { buffer: string }
    expect(buffer.buffer).toContain(dir)

    const listed = await (await fetch(`${base}/api/terminal`)).json() as { terminals: unknown[] }
    expect(listed.terminals).toHaveLength(1)

    await fetch(`${base}/api/terminal/${created.terminal.id}`, { method: 'DELETE' })
    const after = await (await fetch(`${base}/api/terminal`)).json() as { terminals: unknown[] }
    expect(after.terminals).toHaveLength(0)
    await fetch(`${base}/api/terminal/nope/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x' }),
    }).then(response => expect(response.status).toBe(500))
  }, 15_000)
})
