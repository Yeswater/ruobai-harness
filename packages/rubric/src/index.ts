import type { Context } from '@ruobai/cordis'
import { contractOf } from '@ruobai/contract'
import { evaluate } from '@ruobai/delivery'
import type { SessionEvent } from '@ruobai/session'
import type {} from '@ruobai/session'

export const name = 'rubric'
export const inject = ['sessions']

export interface RubricRule {
  id: string
  title: string
  detail: string
  severity: 'high' | 'medium' | 'low'
  /** Event seqs that justify the rule; the report cites, it never asserts. */
  evidence: number[]
}

export interface FailureReport {
  kind: 'turn' | 'hook' | 'guard' | 'delivery'
  seq: number
  summary: string
}

export interface DecisionPoint {
  step: number
  tool: string
  /** How many times this tool ran in a row up to this step. */
  repeat: number
}

export interface Pattern {
  id: string
  label: string
  count: number
}

export interface RubricReport {
  sessionId: string
  verdict: 'pass' | 'fail' | 'unsure'
  rules: RubricRule[]
  failures: FailureReport[]
  decisions: DecisionPoint[]
  patterns: Pattern[]
}

/**
 * Read-only diagnosis of one session.
 *
 * Everything is derived on the fly from the log — nothing is stored, nothing is
 * proposed as a config change. The rule list is a lens over the events, not a
 * second source of truth: `evidence` carries the seqs so a reader can check.
 */
export function analyse(ctx: Context, sessionId: string): RubricReport {
  const events = ctx.sessions.get(sessionId)?.events ?? []
  const failures = collectFailures(events)
  const decisions = collectDecisions(events)
  const patterns = collectPatterns(decisions)
  const verdict = evaluate(ctx, sessionId).verdict

  return {
    sessionId,
    verdict,
    rules: buildRules({
      events,
      failures,
      decisions,
      patterns,
      verdict,
      acceptance: contractOf(ctx, sessionId).open?.acceptance ?? [],
      checks: evaluate(ctx, sessionId).checks,
    }),
    failures,
    decisions,
    patterns,
  }
}

function collectFailures(events: SessionEvent[]): FailureReport[] {
  const failures: FailureReport[] = []
  for (const event of events) {
    if (event.type === 'turn/error') {
      failures.push({ kind: 'turn', seq: event.seq, summary: String(event.data?.message ?? '回合失败') })
      continue
    }
    if (event.type === 'hooks/violation') {
      failures.push({ kind: 'guard', seq: event.seq, summary: String(event.data?.reason ?? '守卫拦截') })
      continue
    }
    if (event.type === 'hooks/verdict' && event.data?.blocked === true) {
      failures.push({ kind: 'hook', seq: event.seq, summary: String(event.data?.reason ?? '检查未通过') })
      continue
    }
    if (event.type === 'delivery/verdict' && event.data?.verdict && event.data.verdict !== 'pass') {
      failures.push({ kind: 'delivery', seq: event.seq, summary: `交付裁决 ${event.data.verdict}` })
    }
  }
  return failures.slice(-40)
}

/** Tool calls in order; the assistant message carries the tool-call parts. */
function collectDecisions(events: SessionEvent[]): DecisionPoint[] {
  const decisions: DecisionPoint[] = []
  let repeat = 0
  let last = ''
  for (const event of events) {
    if (event.type !== 'message/assistant') continue
    const parts = Array.isArray(event.data?.parts) ? event.data.parts as Array<{ type?: string; name?: string }> : []
    for (const part of parts) {
      if (part?.type !== 'tool-call' || typeof part.name !== 'string') continue
      repeat = part.name === last ? repeat + 1 : 1
      last = part.name
      decisions.push({ step: decisions.length + 1, tool: part.name, repeat })
    }
  }
  return decisions
}

function collectPatterns(decisions: DecisionPoint[]): Pattern[] {
  const counts = new Map<string, number>()
  for (const decision of decisions) {
    if (decision.repeat < 3) continue
    counts.set(decision.tool, Math.max(counts.get(decision.tool) ?? 0, decision.repeat))
  }
  return [...counts].map(([tool, count]) => ({
    id: `repeat-${tool}`,
    label: `连续调用 ${tool} ${count} 次`,
    count,
  }))
}

function buildRules(input: {
  events: SessionEvent[]
  failures: FailureReport[]
  decisions: DecisionPoint[]
  patterns: Pattern[]
  verdict: 'pass' | 'fail' | 'unsure'
  acceptance: Array<{ id: string; kind: 'auto' | 'manual' }>
  checks: Array<{ acceptanceId: string; status: string; reason: string }>
}): RubricRule[] {
  const rules: RubricRule[] = []

  const turnErrors = input.failures.filter(failure => failure.kind === 'turn')
  if (turnErrors.length >= 2) {
    rules.push({
      id: 'turn-errors',
      title: '会话内多次回合失败',
      detail: `出现 ${turnErrors.length} 次回合失败，先定位第一个失败再继续，不要带着错误往下走。`,
      severity: 'high',
      evidence: turnErrors.map(failure => failure.seq),
    })
  }

  const guards = input.failures.filter(failure => failure.kind === 'guard')
  if (guards.length) {
    rules.push({
      id: 'guard-blocks',
      title: '守卫拦截过危险操作',
      detail: `被拦截 ${guards.length} 次；换路径而不是重试同一条命令。`,
      severity: 'high',
      evidence: guards.map(failure => failure.seq),
    })
  }

  const hookBlocks = input.failures.filter(failure => failure.kind === 'hook')
  if (hookBlocks.length >= 2) {
    rules.push({
      id: 'hook-repeats',
      title: '同一处检查反复不通过',
      detail: `检查层阻断了 ${hookBlocks.length} 轮；先修根因，再重复提交。`,
      severity: 'high',
      evidence: hookBlocks.map(failure => failure.seq),
    })
  }

  const manualPending = input.checks.filter(check => check.status === 'manual-pending')
  if (manualPending.length) {
    rules.push({
      id: 'manual-acceptance',
      title: '手工验收项未确认',
      detail: `${manualPending.map(check => check.acceptanceId).join('、')} 需要客户确认，模型不能代签。`,
      severity: 'medium',
      evidence: [],
    })
  }

  if (input.verdict === 'fail' && !manualPending.length) {
    rules.push({
      id: 'delivery-incomplete',
      title: '交付缺口未补齐',
      detail: '有自动验收项缺少可追溯证据；补齐证据再声明完成。',
      severity: 'high',
      evidence: [],
    })
  }

  for (const pattern of input.patterns) {
    rules.push({
      id: pattern.id,
      title: '重复调用同一工具',
      detail: `${pattern.label}；确认是否在原地打转。`,
      severity: 'medium',
      evidence: [],
    })
  }

  const touched = new Map<string, number>()
  for (const event of input.events) {
    if (event.type !== 'file/change' || typeof event.data?.path !== 'string') continue
    touched.set(event.data.path, (touched.get(event.data.path) ?? 0) + 1)
  }
  for (const [path, count] of touched) {
    if (count < 3) continue
    rules.push({
      id: `churn-${path}`,
      title: '同一文件反复修改',
      detail: `${path} 被改了 ${count} 次；先读完整再改，避免来回拉锯。`,
      severity: 'low',
      evidence: [],
    })
  }

  return rules
}

export default { name, inject }
