import { resolve } from 'node:path'
import type { Context } from '@ruobai/cordis'
import { judge, loadTasks, RESULT_EVENT, type EvalResult } from '@ruobai/eval'
import type {} from '@ruobai/session'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export interface Config {
  evalsRoot?: string
}

export const name = 'eval-web'
export const inject = ['web', 'sessions']

export const PROPOSED_EVENT = 'harness/proposed'
export const REJECTED_EVENT = 'harness/rejected'
export const APPLIED_EVENT = 'harness/applied'

/**
 * Evaluation API: task definitions, recorded results, and the gate.
 *
 * This plugin never runs a command and never writes `cordis.yml`. A run is
 * recorded by whoever executed it (the agent's bash tool, or a human); the gate
 * only compares two recorded runs and, on `accept`, writes a proposal event.
 * Applying a proposal stays a human action.
 */
export function apply(ctx: Context, config: Config = {}) {
  const evalsRoot = resolve(config.evalsRoot ?? '.ruobai/evals')

  ctx.effect(() => ctx.web.register({
    prefix: '/api/evals',
    handler: async (req, res, url) => {
      if (url.pathname === '/api/evals' && (req.method ?? 'GET') === 'GET') {
        const sessionId = url.searchParams.get('sessionId')?.trim()
        if (!sessionId) throw new HttpError(400, 'sessionId is required')
        if (!ctx.sessions.get(sessionId)) throw new HttpError(404, 'unknown session')
        sendJson(res, 200, {
          tasks: await loadTasks(evalsRoot),
          results: resultsOf(ctx, sessionId),
        })
        return true
      }

      if (req.method === 'POST') {
        const body = await readJson(req) as Record<string, unknown>
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId) throw new HttpError(400, 'sessionId is required')
        if (!ctx.sessions.get(sessionId)) throw new HttpError(404, 'unknown session')

        if (url.pathname === '/api/evals/record') {
          const result = normalizeResult(body)
          ctx.sessions.append(sessionId, RESULT_EVENT, result)
          sendJson(res, 200, { ok: true, result })
          return true
        }

        if (url.pathname === '/api/evals/judge') {
          const baselineRun = typeof body?.baselineRunId === 'string' ? body.baselineRunId : ''
          const candidateRun = typeof body?.candidateRunId === 'string' ? body.candidateRunId : ''
          if (!baselineRun || !candidateRun) throw new HttpError(400, 'baselineRunId and candidateRunId are required')

          const all = resultsOf(ctx, sessionId)
          const decision = judge(
            all.filter(result => result.runId === baselineRun),
            all.filter(result => result.runId === candidateRun),
          )
          const event = {
            id: `gate-${Date.now()}`,
            target: typeof body?.target === 'string' ? body.target : 'cordis.yml',
            diff: typeof body?.diff === 'string' ? body.diff : '',
            why: typeof body?.why === 'string' ? body.why : '',
            baselineRunId: baselineRun,
            candidateRunId: candidateRun,
            verdict: decision.verdict,
            reason: decision.reason,
            at: Date.now(),
          }
          ctx.sessions.append(sessionId, decision.verdict === 'accept' ? PROPOSED_EVENT : REJECTED_EVENT, event)
          sendJson(res, 200, { decision, event })
          return true
        }
      }

      throw new HttpError(404, 'not found')
    },
  }), 'eval-web.api')
}

export default { name, inject, apply }

export function resultsOf(ctx: Context, sessionId: string): EvalResult[] {
  const events = ctx.sessions.get(sessionId)?.events ?? []
  return events
    .filter(event => event.type === RESULT_EVENT)
    .map(event => event.data as unknown as EvalResult)
    .slice(-200)
}

function normalizeResult(body: Record<string, unknown>): EvalResult {
  const task = typeof body.task === 'string' ? body.task.trim() : ''
  const runId = typeof body.runId === 'string' ? body.runId.trim() : ''
  if (!task || !runId) throw new HttpError(400, 'task and runId are required')
  const exitCode = typeof body.exitCode === 'number' ? body.exitCode : null
  return {
    task,
    runId,
    passed: typeof body.passed === 'boolean' ? body.passed : exitCode === 0,
    exitCode,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0,
    at: Date.now(),
    output: typeof body.output === 'string' ? body.output.slice(0, 2_000) : '',
  }
}

export const meta = {
  title: '评测门控',
  description: '任务定义、结果记录，以及基线/候选对比。',
}
