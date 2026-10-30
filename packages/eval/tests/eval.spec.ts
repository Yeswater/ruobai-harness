import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { judge, loadTasks, type EvalResult } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function result(task: string, passed: boolean): EvalResult {
  return {
    task,
    runId: 'r1',
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: 10,
    at: 1,
    output: '',
  }
}

describe('eval gate', () => {
  it('refuses to judge without a baseline', () => {
    expect(judge([], [result('a', true)]).verdict).toBe('needs-baseline')
  })

  it('accepts when both sides pass everything', () => {
    expect(judge([result('a', true)], [result('a', true)])).toMatchObject({ verdict: 'accept' })
  })

  it('rejects a regression on a task the baseline passed', () => {
    const decision = judge([result('a', true), result('b', true)], [result('a', true), result('b', false)])
    expect(decision.verdict).toBe('reject')
    expect(decision.reason).toContain('b')
  })

  it('accepts when a partial baseline improves without losing anything', () => {
    const decision = judge([result('a', true), result('b', false)], [result('a', true), result('b', true)])
    expect(decision.verdict).toBe('accept')
  })

  it('rejects when the candidate drops a task the baseline passed', () => {
    const decision = judge([result('a', true), result('b', true)], [result('a', true)])
    expect(decision.verdict).toBe('reject')
    expect(decision.reason).toContain('b')
  })

  it('rejects an empty candidate instead of reading it as neutral', () => {
    expect(judge([result('a', true)], []).verdict).toBe('reject')
  })
})

describe('eval tasks', () => {
  it('loads task files and skips malformed ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbu-evals-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'a.json'), JSON.stringify({ name: 'a', command: 'true' }))
    await writeFile(join(root, 'broken.json'), '{ not json')
    await writeFile(join(root, 'ignored.txt'), 'x')

    const tasks = await loadTasks(root)
    expect(tasks.map(task => task.name)).toEqual(['a'])
  })

  it('returns an empty list for a missing directory', async () => {
    expect(await loadTasks(join(tmpdir(), 'rbu-no-evals'))).toEqual([])
  })
})
