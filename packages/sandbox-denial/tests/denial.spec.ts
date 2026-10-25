import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import DenialService, { commandFamily, kindOfOperation, parseLogRecord } from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const ctx = new Context()
  const fiber = ctx.plugin(DenialService)
  await fiber
  cleanups.push(() => fiber.dispose())
  return { ctx, service: ctx.denial }
}

function result(overrides: Partial<Parameters<DenialService['classify']>[0]> = {}) {
  return {
    runId: 'r1',
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 1,
    truncated: false,
    denials: [],
    ...overrides,
  }
}

describe('log parsing', () => {
  it('extracts pid, operation and target', () => {
    const record = parseLogRecord('2026-10-25 23:12:24.156 E  kernel[0:fa04d1] (Sandbox) Sandbox: curl(12061) deny(1) network-outbound remote:*:80')
    expect(record).toMatchObject({
      pid: 12061,
      processName: 'curl',
      operation: 'network-outbound',
      target: 'remote:*:80',
    })
  })

  it('ignores unrelated lines', () => {
    expect(parseLogRecord('something else entirely')).toBeUndefined()
  })
})

describe('classification', () => {
  it('maps native operations to platform-neutral kinds', () => {
    expect(kindOfOperation('file-read-data', true)).toBe('fs-read-guarded')
    expect(kindOfOperation('file-write-data', true)).toBe('fs-write-guarded')
    expect(kindOfOperation('file-write-data', false)).toBe('fs-write-outside')
    expect(kindOfOperation('network-outbound remote:*:443', false)).toBe('network-outbound')
    expect(kindOfOperation('process-exec', false)).toBe('process-exec')
    expect(kindOfOperation('signal', false)).toBe('process-control')
    expect(kindOfOperation('mach-lookup', false)).toBe('mach-lookup')
  })

  it('uses native log evidence with high confidence', async () => {
    const { service } = await setup()
    const denials = service.classify(result({
      denials: [{ pid: 42, operation: 'file-read-data', target: '/Users/x/.ssh/id_rsa', at: Date.now() }],
      pids: [42],
    }), { command: 'cat ~/.ssh/id_rsa', sessionId: 's1' })
    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({
      kind: 'fs-read-guarded',
      target: '/Users/x/.ssh/id_rsa',
      evidence: 'native-log',
      confidence: 'high',
      sessionId: 's1',
    })
    expect(denials[0].message).toContain('Seatbelt')
  })

  it('attributes ingested log records by pid only', async () => {
    const { service } = await setup()
    service.ingest({ pid: 10, operation: 'file-read-data', target: '/secret', at: Date.now() })
    service.ingest({ pid: 99, operation: 'file-read-data', target: '/other', at: Date.now() })
    const denials = service.classify(result({ pids: [10] }), { command: 'cat /secret' })
    expect(denials.map(denial => denial.target)).toEqual(['/secret'])
  })

  it('reads the execvp signature and exit 71', async () => {
    const { service } = await setup()
    const fromStderr = service.classify(result({
      stderr: "sandbox-exec: execvp() of '/usr/bin/security' failed: Operation not permitted",
    }), { command: 'security find-generic-password -w' })
    expect(fromStderr[0]).toMatchObject({ kind: 'process-exec', evidence: 'stderr', confidence: 'high' })

    const fromExit = service.classify(result({ exitCode: 71 }), { command: 'true' })
    expect(fromExit[0]).toMatchObject({ kind: 'process-exec', evidence: 'exit-code' })
  })

  it('treats silent network failures as low-confidence denials', async () => {
    const { service } = await setup()
    const denials = service.classify(result({ exitCode: 7 }), { command: 'curl -s http://127.0.0.1:4310/' })
    expect(denials[0]).toMatchObject({ kind: 'network-outbound', confidence: 'low', evidence: 'heuristic' })
  })

  it('degrades to unknown when no policy service can attribute the path', async () => {
    const { service } = await setup()
    const denials = service.classify(result({ stderr: 'Operation not permitted' }), {
      command: 'cat /Users/x/.ssh/id_rsa',
      cwd: '/tmp',
    })
    expect(denials[0]).toMatchObject({ kind: 'unknown', confidence: 'low', evidence: 'heuristic' })
    expect(denials[0].guard).toBeUndefined()
  })

  it('counts repeats per fingerprint and resets on unload', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(DenialService)
    await fiber
    const service = ctx.denial as DenialService
    const run = { command: 'cat /Users/x/.ssh/id_rsa', sessionId: 's1' }
    const first = service.classify(result({ denials: [
      { pid: 1, operation: 'file-read-data', target: '/Users/x/.ssh/id_rsa', at: Date.now() },
    ], pids: [1] }), run)
    expect(first[0].repeated).toBe(1)
    expect(service.isRepeating(first[0].fingerprint)).toBe(false)

    const second = service.classify(result({ denials: [
      { pid: 2, operation: 'file-read-data', target: '/Users/x/.ssh/id_rsa', at: Date.now() },
    ], pids: [2] }), run)
    expect(second[0].repeated).toBe(2)
    expect(service.isRepeating(second[0].fingerprint)).toBe(true)

    // Unload must drop the counters: otherwise a reloaded sandbox would
    // immediately consider the first denial "repeated" and refuse to escalate.
    const generation = service.currentGeneration()
    await fiber.dispose()
    expect(service.currentGeneration()).toBeGreaterThan(generation)
    expect(service.isRepeating(second[0].fingerprint)).toBe(false)
  })

  it('emits typed events', async () => {
    const { ctx } = await setup()
    const seen: string[] = []
    ctx.on('sandbox/denied', () => seen.push('denied'))
    ctx.on('sandbox/denial-repeated', () => seen.push('repeated'))
    const run = { command: 'cat /Users/x/.ssh/id_rsa' }
    ctx.denial.classify(result({ denials: [{ pid: 1, operation: 'file-read-data', target: '/Users/x/.ssh/id_rsa', at: Date.now() }], pids: [1] }), run)
    ctx.denial.classify(result({ denials: [{ pid: 2, operation: 'file-read-data', target: '/Users/x/.ssh/id_rsa', at: Date.now() }], pids: [2] }), run)
    expect(seen).toEqual(['denied', 'denied', 'repeated'])
  })

  it('derives the command family for fingerprints', () => {
    expect(commandFamily('  git status')).toBe('git')
    expect(commandFamily('cat a | grep b')).toBe('cat')
    expect(commandFamily('/usr/bin/security -w')).toBe('security')
  })

  it('returns nothing when the run succeeded', async () => {
    const { service } = await setup()
    expect(service.classify(result({ exitCode: 0 }), { command: 'ls' })).toEqual([])
  })

  it('filters start-up probes so they never reach escalation', async () => {
    const { service } = await setup()
    // Every exec produces these; treating them as boundary hits would prompt
    // on every single command (appendix A18).
    const denials = service.classify(result({
      exitCode: 0,
      denials: [
        { pid: 1, operation: 'file-write-data', target: '/dev/dtracehelper', at: Date.now() },
        { pid: 1, operation: 'sysctl-read', target: 'kern.bootargs', at: Date.now() },
        { pid: 1, operation: 'file-read-metadata', target: '/Users/x', at: Date.now() },
        { pid: 1, operation: 'process-info-pidinfo', target: 'self', at: Date.now() },
        { pid: 1, operation: 'mach-lookup', target: 'kcfpreferencesanyapplication', at: Date.now() },
        { pid: 1, operation: 'user-preference-read', target: 'kcfpreferencesanyapplication', at: Date.now() },
        { pid: 1, operation: 'network-outbound', target: '/private/var/run/syslog', at: Date.now() },
      ],
      pids: [1],
    }), { command: 'echo hi' })
    expect(denials).toEqual([])
  })

  it('does not filter per-application preference reads', async () => {
    const { service } = await setup()
    // Only the *global* defaults domain is a start-up probe; an app domain may
    // hold tokens and stays a real denial.
    const denials = service.classify(result({
      exitCode: 1,
      denials: [
        { pid: 1, operation: 'user-preference-read', target: 'com.apple.Safari', at: Date.now() },
      ],
      pids: [1],
    }), { command: 'defaults read com.apple.Safari' })
    expect(denials).toHaveLength(1)
  })

  it('still reports a real file denial next to the noise', async () => {
    const { service } = await setup()
    const denials = service.classify(result({
      denials: [
        { pid: 1, operation: 'file-write-data', target: '/dev/dtracehelper', at: Date.now() },
        { pid: 1, operation: 'network-outbound', target: 'remote:*:4310', at: Date.now() },
      ],
      pids: [1],
    }), { command: 'curl http://127.0.0.1:4310/' })
    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({ kind: 'network-outbound', target: 'remote:*:4310' })
  })
})
