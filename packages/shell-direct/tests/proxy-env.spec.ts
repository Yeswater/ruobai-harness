import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function harness(): Promise<Harness> {
  const created = await createHarness()
  cleanups.push(() => created.dispose())
  return created
}

function readEnv(h: Harness) {
  return h.ctx.shell.run({
    command: 'printf "%s|%s|%s" "$HTTP_PROXY" "$HTTPS_PROXY" "$NO_PROXY"',
    cwd: h.dir,
    root: h.dir,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    sessionId: 's1',
  })
}

describe('shell proxy environment', () => {
  it('exports application proxies and NO_PROXY to commands', async () => {
    const h = await harness()
    await h.ctx.settings.update({
      network: {
        enabled: true,
        httpProxy: 'http://127.0.0.1:7899',
        httpsProxy: 'http://127.0.0.1:7899',
        noProxy: 'localhost,.local',
      },
    })

    const status = await h.ctx.net.status(true)
    expect(status.effective.http).toBe('http://127.0.0.1:7899')
    expect(status.effective.https).toBe('http://127.0.0.1:7899')

    const result = await readEnv(h)
    expect(result.content).toContain('http://127.0.0.1:7899|http://127.0.0.1:7899|localhost,.local')
  })

  it('does not export proxy variables when the proxy is off', async () => {
    const h = await harness()
    await h.ctx.settings.update({ network: { enabled: false } })

    const result = await readEnv(h)
    expect(result.content).not.toContain('127.0.0.1:7899')
    expect(result.content).toContain('||')
  })
})
