import { randomUUID } from 'node:crypto'
import { type Context, Service } from '@ruobai/cordis'
import {
  type CheckResult,
  type Diagnostic,
  fingerprintOf,
  type LintService,
  type Partition,
} from '@ruobai/lint'
import type { SessionEvent } from '@ruobai/session'
import type { HookSettings } from '@ruobai/settings'
import {
  DEFAULT_AUDIT_PROMPT,
  parseAuditFindings,
  renderAuditInput,
} from './audit.ts'
import {
  DEFAULT_DENY_COMMAND,
  DEFAULT_DENY_WRITE,
  type GuardCall,
  type GuardDecision,
  guardCall,
} from './guard.ts'
import { renderDiagnostics, renderInfrastructure } from './render.ts'
import type { HookLayer, HookRunView, HookStatusView } from './types.ts'

export { parseAuditFindings, renderAuditInput } from './audit.ts'
export {
  DEFAULT_DENY_COMMAND,
  DEFAULT_DENY_WRITE,
  globToRegExp,
  guardCall,
  matchesAny,
} from './guard.ts'
export { renderDiagnostics } from './render.ts'
export type * from './types.ts'

export interface AfterToolResult {
  diagnostics: Diagnostic[]
  /** Injected as an ephemeral user message before the next step. */
  feedback?: string
}

export interface StopDecision {
  blocked: boolean
  escalated?: boolean
  diagnostics: Diagnostic[]
  feedback?: string
}

/** What the delivery plugin exposes to the gate; kept structural on purpose. */
interface DeliveryObservable {
  contractId: string
  verdict: 'pass' | 'fail' | 'unsure'
  checks: Array<{ acceptanceId: string; status: string; reason: string }>
  at: number
  reason?: string
}

interface RoundState {
  key: string
  round: number
  last: string
}

interface MetricsState {
  runs: number
  passes: number
  blocks: number
  escalations: number
  violations: number
  totalDurationMs: number
  lastRunAt?: number
  lastBlockAt?: number
}

declare module '@ruobai/cordis' {
  interface Context {
    hooks: HooksService
  }

  interface Events {
    'hooks/run'(run: HookRunView): void
    'hooks/blocked'(info: { sessionId: string; round: number }): void
    'hooks/escalated'(info: { sessionId: string; reason: string }): void
    'hooks/violation'(info: {
      sessionId?: string
      tool: string
      reason: string
    }): void
  }
}

/**
 * Lifecycle gates: a deterministic guard before tools, incremental checks
 * after edits, and a blocking gate before a turn is allowed to finish.
 *
 * Settings are read on every call so the settings panel takes effect without
 * reloading the plugin. Everything is optional: without `lint`, the service
 * still guards but never blocks on checks.
 */
export class HooksService extends Service {
  static inject = ['sessions']

  private readonly runs: HookRunView[] = []
  private readonly rounds = new Map<string, RoundState>()
  private readonly deliverRounds = new Map<string, RoundState>()
  private readonly auditing = new Set<string>()
  private metrics: MetricsState = {
    runs: 0,
    passes: 0,
    blocks: 0,
    escalations: 0,
    violations: 0,
    totalDurationMs: 0,
  }
  private auditDay = ''
  private auditUsed = 0

  constructor(ctx: Context) {
    super(ctx, 'hooks')
  }

  settings(): HookSettings {
    const settings = this.ctx.get('settings', false) as
      | { raw?(): { hooks?: HookSettings } }
      | undefined
    return settings?.raw?.().hooks ?? {}
  }

  rootFor(sessionId?: string) {
    const workspace = this.ctx.get('workspace', false) as
      | { rootFor?(sessionId?: string): string }
      | undefined
    return workspace?.rootFor?.(sessionId) ?? process.cwd()
  }

  /** Runs before permissions: protecting configuration is not a policy preset. */
  guard(call: GuardCall): GuardDecision | undefined {
    const settings = this.settings()
    if (settings.enabled === false) return undefined
    const decision = guardCall(
      call,
      settings.guard,
      this.rootFor(call.sessionId),
    )
    if (!decision) return undefined
    this.metrics.violations += 1
    if (call.sessionId) {
      this.append(call.sessionId, 'hooks/violation', {
        at: Date.now(),
        tool: call.name,
        reason: decision.reason,
      })
    }
    this.ctx.emit('hooks/violation', {
      ...(call.sessionId ? { sessionId: call.sessionId } : {}),
      tool: call.name,
      reason: decision.reason,
    })
    return decision
  }

  async afterTool(
    call: { name: string; args: Record<string, unknown>; sessionId?: string },
    result: { isError?: boolean },
  ): Promise<AfterToolResult> {
    if (result.isError) return { diagnostics: [] }
    if (call.name !== 'write_file' && call.name !== 'edit_file')
      return { diagnostics: [] }
    const settings = this.settings()
    if (settings.enabled === false || settings.edit?.enabled === false)
      return { diagnostics: [] }
    const path = typeof call.args?.path === 'string' ? call.args.path : ''
    if (!path) return { diagnostics: [] }
    const lint = this.ctx.get('lint', false) as LintService | undefined
    if (!lint) return { diagnostics: [] }

    const root = this.rootFor(call.sessionId)
    const check = await lint.run({
      scope: 'edit',
      files: [path],
      cwd: root,
      root,
      ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    })
    const partition = await lint.partition(check.diagnostics, root)
    const fresh = [...partition.fresh, ...partition.worsened]
    const limit = settings.edit?.maxDiagnostics ?? 20
    const shown = fresh.slice(0, limit)
    this.recordRun('edit', check, partition, shown, call.sessionId, false)

    const failed = check.checkers.filter((checker) => checker.error)
    if (!fresh.length && failed.length && settings.edit?.failure === 'close') {
      return {
        diagnostics: [],
        feedback: renderInfrastructure(failed.map((checker) => checker.id)),
      }
    }
    if (!shown.length) return { diagnostics: [] }
    return {
      diagnostics: shown,
      feedback: renderDiagnostics(shown, 'edit', 1, limit),
    }
  }

  /**
   * Called when the model stops calling tools. Returns `blocked: true` to keep
   * the turn alive; the breaker escalates instead of looping forever.
   */
  async beforeStop(sessionId: string): Promise<StopDecision> {
    const settings = this.settings()
    if (settings.enabled === false || settings.stop?.enabled === false) {
      return { blocked: false, diagnostics: [] }
    }
    const lint = this.ctx.get('lint', false) as LintService | undefined
    if (!lint) return { blocked: false, diagnostics: [] }

    const root = this.rootFor(sessionId)
    const limit = settings.stop?.maxDiagnostics ?? 20
    let check: CheckResult
    try {
      check = await lint.run({ scope: 'stop', cwd: root, root, sessionId })
    } catch (error) {
      if (settings.stop?.failure !== 'close') {
        this.ctx
          .logger('hooks')
          .warn(
            'stop gate unavailable: %s',
            error instanceof Error ? error.message : String(error),
          )
        return { blocked: false, diagnostics: [] }
      }
      const diagnostic = this.infrastructureDiagnostic(error)
      return this.blockWith(
        sessionId,
        [diagnostic],
        limit,
        settings.stop?.maxRounds ?? 2,
      )
    }

    const partition = await lint.partition(check.diagnostics, root)
    const failed = check.checkers.filter((checker) => checker.error)
    this.recordRun(
      'stop',
      check,
      partition,
      partition.blocking.slice(0, limit),
      sessionId,
      false,
    )

    if (!partition.blocking.length) {
      if (failed.length && settings.stop?.failure === 'close') {
        return this.blockWith(
          sessionId,
          [
            this.infrastructureDiagnostic(
              failed.map((checker) => checker.id).join(', '),
            ),
          ],
          limit,
          settings.stop?.maxRounds ?? 2,
        )
      }
      this.rounds.delete(sessionId)
      this.metrics.passes += 1
      if (settings.audit?.enabled && settings.audit.trigger === 'stop') {
        void this.audit(sessionId, 'stop')
      }
      return { blocked: false, diagnostics: [] }
    }

    return this.blockWith(
      sessionId,
      partition.blocking,
      limit,
      settings.stop?.maxRounds ?? 2,
    )
  }

  /**
   * Delivery gate: every acceptance item of the open contract must be covered.
   *
   * Fail-closed by design, unlike the stop gate: a code check that cannot run
   * may be skipped, but a delivery claim that cannot be judged must never read
   * as a pass.
   */
  async beforeDeliver(sessionId: string): Promise<StopDecision> {
    const settings = this.settings()
    if (settings.enabled === false || settings.deliver?.enabled === false) {
      return { blocked: false, diagnostics: [] }
    }

    const delivery = this.ctx.get('delivery', false) as
      | { evaluate(sessionId: string): DeliveryObservable }
      | undefined
    if (!delivery) {
      // An unmounted gate is invisible unless it says so.
      this.append(sessionId, 'gate/skipped', {
        at: Date.now(),
        gate: 'deliver',
        reason: 'delivery-not-mounted',
      })
      return { blocked: false, diagnostics: [] }
    }

    let outcome: DeliveryObservable
    try {
      outcome = delivery.evaluate(sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.append(sessionId, 'delivery/verdict', {
        contractId: '',
        verdict: 'unsure',
        checks: [],
        reason: `gate-unavailable: ${message}`,
        at: Date.now(),
      })
      return { blocked: false, diagnostics: [] }
    }

    if (outcome.reason === 'no-contract') {
      this.append(sessionId, 'gate/skipped', {
        at: Date.now(),
        gate: 'deliver',
        reason: 'no-contract',
      })
      return { blocked: false, diagnostics: [] }
    }

    if (outcome.verdict === 'pass') {
      this.deliverRounds.delete(sessionId)
      this.append(sessionId, 'delivery/verdict', outcome)
      return { blocked: false, diagnostics: [] }
    }

    return this.blockDelivery(sessionId, outcome, settings.deliver?.maxRounds ?? 3)
  }

  /**
   * Block the turn with the acceptance gaps; escalate instead of looping.
   *
   * The breaker mirrors the stop gate's: the same fingerprint twice, or too
   * many rounds, downgrades the verdict to `unsure` and lets the turn end.
   */
  private blockDelivery(
    sessionId: string,
    outcome: DeliveryObservable,
    maxRounds: number,
  ): StopDecision {
    const key = this.turnKey(sessionId)
    const current = this.deliverRounds.get(sessionId)
    const state: RoundState = current && current.key === key ? current : { key, round: 0, last: '' }
    this.deliverRounds.set(sessionId, state)

    const missing = outcome.checks.filter(check => check.status !== 'passed')
    const fingerprint = missing
      .map(check => `${check.acceptanceId}:${check.status}`)
      .sort()
      .join('|')

    if (state.round >= maxRounds || state.last === fingerprint) {
      const reason = state.last === fingerprint ? 'no-progress' : 'max-rounds'
      this.metrics.escalations += 1
      this.append(sessionId, 'delivery/verdict', {
        ...outcome,
        verdict: 'unsure',
        reason,
        at: Date.now(),
      })
      this.append(sessionId, 'hooks/escalated', {
        at: Date.now(),
        reason,
        acceptance: missing.map(check => check.acceptanceId),
      })
      this.ctx.emit('hooks/escalated', { sessionId, reason })
      return { blocked: false, escalated: true, diagnostics: [] }
    }

    state.round += 1
    state.last = fingerprint
    this.metrics.blocks += 1
    this.metrics.lastBlockAt = Date.now()
    return {
      blocked: true,
      diagnostics: [],
      feedback: [
        `<delivery-gate round="${state.round}" missing="${missing.length}">`,
        ...missing.map(check => `${check.acceptanceId} [${check.status}] ${check.reason}`),
        '</delivery-gate>',
      ].join('\n'),
    }
  }

  /** Dry run used by the settings panel; never blocks and never feeds back. */
  async run(
    layer: 'edit' | 'stop',
    options: { files?: string[]; sessionId?: string } = {},
  ) {
    const lint = this.ctx.get('lint', false) as LintService | undefined
    if (!lint) throw new Error('lint service is not loaded')
    const root = this.rootFor(options.sessionId)
    const check = await lint.run({
      scope: layer,
      ...(options.files?.length ? { files: options.files } : {}),
      cwd: root,
      root,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    })
    const partition = await lint.partition(check.diagnostics, root)
    this.recordRun(
      layer,
      check,
      partition,
      check.diagnostics.slice(0, 50),
      options.sessionId,
      false,
    )
    return { check, partition }
  }

  status(): HookStatusView {
    const settings = this.settings()
    const enabled = settings.enabled !== false
    const average = this.metrics.runs
      ? Math.round(this.metrics.totalDurationMs / this.metrics.runs)
      : 0
    const lastRun = this.runs.at(-1)
    return {
      enabled,
      layers: {
        edit: enabled && settings.edit?.enabled !== false,
        stop: enabled && settings.stop?.enabled !== false,
        audit: settings.audit?.enabled === true,
        deliver: enabled && settings.deliver?.enabled !== false,
      },
      metrics: {
        ...this.metrics,
        averageDurationMs: average,
        ...(this.metrics.lastRunAt
          ? { lastRunAt: this.metrics.lastRunAt }
          : {}),
        ...(this.metrics.lastBlockAt
          ? { lastBlockAt: this.metrics.lastBlockAt }
          : {}),
      },
      checkers: (
        (this.ctx.get('lint', false) as LintService | undefined)?.list() ?? []
      ).map((checker) => ({
        id: checker.id,
        scope: checker.scope,
        command: checker.command,
        writes: Boolean(checker.writes),
        enabled: checker.enabled !== false,
      })),
      guard: {
        denyWrite: DEFAULT_DENY_WRITE,
        denyCommand: DEFAULT_DENY_COMMAND,
      },
      ...(lastRun ? { lastRun } : {}),
    }
  }

  listRuns(limit = 20) {
    return this.runs.slice(-Math.max(1, limit)).reverse()
  }

  /** Optional semantic audit; findings never block. */
  async audit(sessionId: string, trigger: 'stop' | 'manual') {
    const settings = this.settings()
    const audit = settings.audit
    if (!audit?.enabled || audit.trigger === 'off') return undefined
    if (trigger === 'stop' && audit.trigger !== 'stop') return undefined
    if (this.auditing.has(sessionId)) return undefined
    if (!this.consumeAuditBudget(audit.dailyBudget ?? 50)) return undefined

    const llm = this.ctx.get('llm', false) as
      | {
          get?(id: string): unknown
          complete?(
            request: unknown,
            provider?: string,
          ): Promise<{ content: string; error?: string }>
        }
      | undefined
    const settingsService = this.ctx.get('settings', false) as
      | {
          raw?(): { llm?: { activeProvider?: string; activeModel?: string } }
          findProvider?(
            id: string,
          ): { models: Array<{ id: string }> } | undefined
        }
      | undefined
    const raw = settingsService?.raw?.()
    const providerId = audit.provider ?? raw?.llm?.activeProvider
    const model = audit.model ?? raw?.llm?.activeModel
    if (!providerId || !model || !llm?.get?.(providerId) || !llm.complete)
      return undefined
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return undefined

    this.auditing.add(sessionId)
    try {
      const response = await llm.complete(
        {
          model,
          maxTokens: 800,
          cache: { staticOnly: true },
          messages: [
            {
              role: 'system',
              content: [
                { type: 'text', text: audit.prompt || DEFAULT_AUDIT_PROMPT },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: renderAuditInput(record.events, 20) },
              ],
            },
          ],
        },
        providerId,
      )
      if (response.error) {
        this.ctx.logger('hooks').warn('audit failed: %s', response.error)
        return undefined
      }
      const findings = parseAuditFindings(response.content)
      this.append(sessionId, 'hooks/audit', {
        at: Date.now(),
        provider: providerId,
        model,
        findings,
      })
      this.pushRun({
        id: randomUUID(),
        at: Date.now(),
        layer: 'audit',
        sessionId,
        blocked: false,
        fresh: findings.length,
        total: findings.length,
        durationMs: 0,
        checkers: [],
        diagnostics: [],
      })
      return findings
    } catch (error) {
      this.ctx
        .logger('hooks')
        .warn(
          'audit failed: %s',
          error instanceof Error ? error.message : String(error),
        )
      return undefined
    } finally {
      this.auditing.delete(sessionId)
    }
  }

  private blockWith(
    sessionId: string,
    blocking: Diagnostic[],
    limit: number,
    maxRounds: number,
  ): StopDecision {
    const state = this.roundState(sessionId)
    const fingerprint = blocking
      .map((item) => item.fingerprint)
      .sort()
      .join('|')
    if (state.round >= maxRounds || state.last === fingerprint) {
      const reason = state.last === fingerprint ? 'no-progress' : 'max-rounds'
      this.metrics.escalations += 1
      this.append(sessionId, 'hooks/escalated', {
        at: Date.now(),
        reason,
        diagnostics: blocking.slice(0, 10),
      })
      this.ctx.emit('hooks/escalated', { sessionId, reason })
      return {
        blocked: false,
        escalated: true,
        diagnostics: blocking.slice(0, limit),
      }
    }

    state.round += 1
    state.last = fingerprint
    this.metrics.blocks += 1
    this.metrics.lastBlockAt = Date.now()
    this.append(sessionId, 'hooks/blocked', {
      at: Date.now(),
      round: state.round,
      diagnostics: blocking.slice(0, 10),
    })
    this.ctx.emit('hooks/blocked', { sessionId, round: state.round })
    const shown = blocking.slice(0, limit)
    return {
      blocked: true,
      diagnostics: shown,
      feedback: renderDiagnostics(shown, 'stop', state.round, limit),
    }
  }

  private roundState(sessionId: string): RoundState {
    const key = this.turnKey(sessionId)
    const current = this.rounds.get(sessionId)
    if (current && current.key === key) return current
    const next: RoundState = { key, round: 0, last: '' }
    this.rounds.set(sessionId, next)
    return next
  }

  private turnKey(sessionId: string) {
    const record = this.ctx.sessions.get(sessionId)
    const last = [...(record?.events ?? [])]
      .reverse()
      .find(
        (event) =>
          event.type === 'message/user' && event.data?.source?.kind !== 'hook',
      )
    return String(last?.data?.id ?? '')
  }

  private recordRun(
    layer: HookLayer,
    check: CheckResult,
    partition: Partition,
    diagnostics: Diagnostic[],
    sessionId: string | undefined,
    blocked: boolean,
  ) {
    const run: HookRunView = {
      id: randomUUID(),
      at: Date.now(),
      layer,
      ...(sessionId ? { sessionId } : {}),
      blocked,
      fresh: partition.fresh.length + partition.worsened.length,
      total: check.diagnostics.length,
      durationMs: check.durationMs,
      checkers: check.checkers,
      diagnostics,
    }
    this.metrics.totalDurationMs += check.durationMs
    return this.pushRun(run)
  }

  private pushRun(run: HookRunView) {
    this.runs.push(run)
    if (this.runs.length > 50) this.runs.shift()
    this.metrics.runs += 1
    this.metrics.lastRunAt = run.at
    this.ctx.emit('hooks/run', run)
    return run
  }

  private infrastructureDiagnostic(input: unknown): Diagnostic {
    const message =
      input instanceof Error
        ? input.message
        : String(input ?? 'checker unavailable')
    const rule = 'hook/checker'
    const path = '.'
    return {
      path,
      rule,
      level: 'error',
      message: `检查器不可用：${message}`,
      fingerprint: fingerprintOf(rule, path, message),
    }
  }

  private consumeAuditBudget(budget: number) {
    const day = new Date().toISOString().slice(0, 10)
    if (day !== this.auditDay) {
      this.auditDay = day
      this.auditUsed = 0
    }
    if (budget > 0 && this.auditUsed >= budget) return false
    this.auditUsed += 1
    return true
  }

  private append(sessionId: string, type: string, data: unknown) {
    if (!this.ctx.sessions.has(sessionId)) return
    this.ctx.sessions.append(sessionId, type, data as SessionEvent['data'])
  }
}

export default HooksService

export const meta = {
  title: '生命周期门禁',
  description: '在编辑、停止与危险操作前执行确定性检查与保护。',
}
