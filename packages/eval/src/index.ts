import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/session'

export const name = 'eval'
export const inject = ['sessions']

export const RESULT_EVENT = 'eval/result'

export interface EvalTask {
  name: string
  description?: string
  /** Command run to decide the task; must exit 0 when the task is met. */
  command: string
  expectExit?: number
  timeoutMs?: number
}

export interface EvalResult {
  task: string
  runId: string
  passed: boolean
  exitCode: number | null
  durationMs: number
  at: number
  output: string
}

export type GateVerdict = 'accept' | 'reject' | 'needs-baseline'

export interface GateDecision {
  verdict: GateVerdict
  reason: string
}

/**
 * Judge a candidate run against a baseline run.
 *
 * The only question is "not worse": a candidate may not lose a task the
 * baseline passed, and may not pass fewer tasks overall. A missing baseline is
 * never treated as "no regressions" — it is a refusal to judge.
 */
export function judge(baseline: EvalResult[], candidate: EvalResult[]): GateDecision {
  if (!baseline.length) {
    return { verdict: 'needs-baseline', reason: '还没有基线运行结果，不能判断改动是否变差' }
  }
  if (!candidate.length) {
    return { verdict: 'reject', reason: '候选运行没有结果，不能当作中性' }
  }

  const basePassed = new Set(baseline.filter(result => result.passed).map(result => result.task))
  const candidateByTask = new Map(candidate.map(result => [result.task, result]))
  // A missing task is a regression, not a smaller sample: the candidate set is
  // the same set of tasks, so anything the baseline passed must still pass.
  const regressions = [...basePassed].filter(task => candidateByTask.get(task)?.passed !== true)
  if (regressions.length) {
    return { verdict: 'reject', reason: `基线通过的任务在候选中失败：${regressions.join('、')}` }
  }

  const baseCount = baseline.filter(result => result.passed).length
  const candidateCount = candidate.filter(result => result.passed).length
  return { verdict: 'accept', reason: `通过 ${baseCount} → ${candidateCount}，没有回归` }
}

export async function loadTasks(root: string): Promise<EvalTask[]> {
  const dir = resolve(root)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const tasks: EvalTask[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(dir, entry), 'utf8')) as Partial<EvalTask>
      if (typeof parsed.name !== 'string' || typeof parsed.command !== 'string') continue
      tasks.push({
        name: parsed.name,
        description: typeof parsed.description === 'string' ? parsed.description : '',
        command: parsed.command,
        ...(typeof parsed.expectExit === 'number' ? { expectExit: parsed.expectExit } : {}),
        ...(typeof parsed.timeoutMs === 'number' ? { timeoutMs: parsed.timeoutMs } : {}),
      })
    } catch {
      // A malformed task file is skipped, not fatal: the set is a file tree.
    }
  }
  return tasks.sort((left, right) => left.name.localeCompare(right.name))
}

export async function ensureTasks(root: string) {
  await mkdir(resolve(root), { recursive: true })
}

export default { name, inject }
