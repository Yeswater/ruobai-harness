import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import type { ApprovalRule } from '@ruobai/settings'
import { builtinDangerRules, dangerFor } from './danger.ts'
import { exactRule, matchesRule, type ApprovalSubject } from './rules.ts'

export type { ApprovalSubject } from './rules.ts'
export type { DangerMatch, DangerRule } from './danger.ts'
export { builtinDangerRules, DANGER_RULES, dangerFor } from './danger.ts'

export type ApprovalDecision = 'allow' | 'always' | 'deny'

/**
 * Two kinds of request share this service:
 *
 * - `tool`: the pre-existing "mutating tool needs a human" flow. `bypass`
 *   settings and permission modes apply.
 * - `escalation`: the sandbox hit a hard boundary. Never bypassed, never
 *   relaxed by a permission mode, and never persisted by "always".
 */
export type ApprovalKind = 'tool' | 'escalation'

/**
 * Sandbox-neutral description of what a human is being asked to relax.
 *
 * Deliberately loose: `approval` must not depend on the sandbox packages, so
 * the escalation service supplies a value that fits this shape.
 */
export interface EscalationSummary {
  kind: string
  target?: string
  guard?: string
  command: string
  /** Opaque here; interpreted by the escalation service on retry. */
  exemption: unknown
  retry: 'safe' | 'unsafe'
  attempt: number
  evidence?: string
  confidence?: string
}

export interface ApprovalPreview {
  summary: string
  diff?: string
}

export interface ApprovalRequest extends ApprovalPreview {
  id: string
  sessionId: string
  tool: string
  args: unknown
  /** Defaults to `tool` for backwards compatibility. */
  kind: ApprovalKind
  /** Present for escalations: what the sandbox blocked and what would relax. */
  escalation?: EscalationSummary
  /** What a persistent rule would match against; absent for tools without one. */
  subject?: ApprovalSubject
  /** Set when a built-in or custom danger rule forces this confirmation. */
  guard?: string
  createdAt: number
}

export interface ApprovalResolution {
  id: string
  decision: ApprovalDecision
  request: ApprovalRequest
}

/** A plugin-contributed rule set, e.g. managed / project / user level. */
export interface RuleSource {
  id: string
  /** Higher wins for ordering; deny still outranks any allow across sources. */
  priority: number
  version(): number
  rules(): readonly ApprovalRule[]
}

export interface DeadlinePolicy {
  timeoutMs: number
  /** Fail closed. The type admits no other value on purpose. */
  onTimeout: 'deny'
}

export const DEFAULT_DEADLINE: DeadlinePolicy = { timeoutMs: 180_000, onTimeout: 'deny' }
const MIN_DEADLINE = 5_000
const MAX_DEADLINE = 600_000

declare module '@ruobai/cordis' {
  interface Context {
    approval: ApprovalService
  }

  interface Events {
    'approval/requested'(request: ApprovalRequest): void
    'approval/resolved'(resolution: ApprovalResolution): void
    'approval/timeout'(request: ApprovalRequest, policy: DeadlinePolicy): void
  }
}

export interface ApprovalRequestInput extends ApprovalPreview {
  sessionId: string
  tool: string
  args: unknown
  kind?: ApprovalKind
  escalation?: EscalationSummary
  subject?: ApprovalSubject
}

/**
 * Blocks mutating tool calls and sandbox escalations until a human decides.
 *
 * Decisions default to deny when the turn is aborted, the deadline expires, or
 * the service unloads. "always" is scoped to one session + tool for the process
 * lifetime, and never persists an escalation.
 */
export class ApprovalService extends Service {
  private readonly pending = new Map<string, { request: ApprovalRequest; settle: (decision: ApprovalDecision) => void }>()
  private readonly always = new Set<string>()
  /** Rules granted in this process when settings cannot persist them. */
  private readonly granted: ApprovalRule[] = []
  private readonly sources = new Map<string, RuleSource>()
  /** `ctx.approval.rules.register(source)` for plugin-contributed rule sets. */
  readonly rules = { register: (source: RuleSource) => this.registerRuleSource(source) }
  private deadline: DeadlinePolicy = { ...DEFAULT_DEADLINE }

  constructor(ctx: Context) {
    super(ctx, 'approval')
    ctx.effect(() => () => {
      this.denyAll()
      this.granted.length = 0
      this.sources.clear()
      this.deadline = { ...DEFAULT_DEADLINE }
    }, 'approval.dispose')
  }

  /** True when settings opt out of approvals entirely. Escalations ignore this. */
  bypassed() {
    const settings = this.ctx.get('settings', false) as
      | { raw(): { agent?: { bypassApprovals?: boolean } } }
      | undefined
    return Boolean(settings?.raw().agent?.bypassApprovals)
  }

  list(sessionId?: string) {
    return [...this.pending.values()]
      .map(entry => entry.request)
      .filter(request => !sessionId || request.sessionId === sessionId)
  }

  /**
   * Registers a rule source. The disposer removes the entry (not just the
   * subscription) so a hot reload cannot leave stale rules behind.
   */
  registerRuleSource(source: RuleSource): () => void {
    const previous = this.sources.get(source.id)
    this.sources.set(source.id, source)
    return () => {
      if (this.sources.get(source.id) !== source) return
      if (previous) this.sources.set(source.id, previous)
      else this.sources.delete(source.id)
    }
  }

  /**
   * Plugins may tune the timeout but cannot disable fail-closed behaviour: the
   * policy type only admits `onTimeout: 'deny'` and the value is clamped.
   */
  setDeadlinePolicy(policy: Partial<DeadlinePolicy>): () => void {
    const previous = this.deadline
    const timeoutMs = Math.min(Math.max(Math.floor(policy.timeoutMs ?? previous.timeoutMs), MIN_DEADLINE), MAX_DEADLINE)
    this.deadline = { timeoutMs, onTimeout: 'deny' }
    return () => {
      this.deadline = previous
    }
  }

  deadlinePolicy(): DeadlinePolicy {
    return this.deadline
  }

  async request(input: ApprovalRequestInput, run: { signal?: AbortSignal } = {}): Promise<ApprovalDecision> {
    const kind: ApprovalKind = input.kind ?? 'tool'
    const permissions = this.ctx.get('permissions', false) as
      | {
        modeFor(sessionId?: string): string
        approval(
          sessionId: string | undefined,
          toolName: string | undefined,
          subject?: ApprovalSubject,
        ): 'allow' | 'deny' | undefined
      }
      | undefined
    const mode = permissions?.modeFor(input.sessionId)
    const guard = this.guard()
    // Full access intentionally skips the built-in danger confirmations;
    // every other mode still escalates dangerous commands to the human.
    // Escalations are already security events: danger rules add nothing.
    const danger = kind === 'tool' && guard.enabled && mode !== 'full-access' && input.subject?.kind === 'command'
      ? dangerFor(input.subject.value)
      : undefined
    const policy = this.decide(input.tool, input.subject)

    if (policy?.action === 'deny') {
      this.ctx.logger('approval').info('rule denied %s: %s', input.tool, policy.rule.pattern)
      return 'deny'
    }

    // Explicit ask rules (built-in or user) outrank the bypass setting and
    // allow rules, matching Claude Code's deny > ask > allow precedence.
    const forced = danger
      ? `内置规则：${danger.label}`
      : policy?.action === 'ask'
        ? `规则：${policy.rule.tool} · ${policy.rule.pattern}`
        : undefined

    if (!forced) {
      if (kind === 'tool') {
        const modeDecision = permissions?.approval(input.sessionId, input.tool, input.subject)
        if (modeDecision === 'deny') return 'deny'
        if (modeDecision === 'allow') return 'allow'
        if (policy?.action === 'allow') return 'allow'
        if (this.bypassed()) return 'allow'

        // Tools without a subject (MCP) keep the old session+tool grant.
        const key = `${input.sessionId}:${input.tool}`
        if (!input.subject && this.always.has(key)) return 'allow'
      } else if (policy?.action === 'allow') {
        // An explicit allow rule still short-circuits an escalation, but only
        // for this request: nothing is persisted.
        return 'allow'
      }
    }

    const request: ApprovalRequest = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...input,
      kind,
      ...(forced ? { guard: forced } : {}),
    }

    const decision = await this.awaitDecision(request, run)
    return decision
  }

  resolve(id: string, decision: ApprovalDecision) {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    if (decision === 'always') this.remember(entry.request)
    this.ctx.emit('approval/resolved', { id, decision, request: entry.request })
    entry.settle(decision)
    return true
  }

  denyAll(sessionId?: string) {
    for (const request of this.list(sessionId)) this.resolve(request.id, 'deny')
  }

  /** Built-in danger rules, surfaced in settings. */
  dangerous() {
    return builtinDangerRules()
  }

  /**
   * Waits for a decision with three cancellation paths (answer, abort,
   * unload) and a fail-closed deadline.
   */
  private awaitDecision(request: ApprovalRequest, run: { signal?: AbortSignal }): Promise<ApprovalDecision> {
    const policy = this.deadline
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false
      const settle = (decision: ApprovalDecision) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        run.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(request.id)
        resolve(decision)
      }
      const onAbort = () => {
        if (this.pending.has(request.id)) this.resolve(request.id, 'deny')
        else settle('deny')
      }
      const timer = setTimeout(() => {
        this.ctx.emit('approval/timeout', request, policy)
        this.pending.delete(request.id)
        settle(policy.onTimeout)
      }, policy.timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      this.pending.set(request.id, { request, settle })
      run.signal?.addEventListener('abort', onAbort, { once: true })
      this.ctx.emit('approval/requested', request)
    })
  }

  private guard(): { enabled: boolean } {
    const settings = this.ctx.get('settings', false) as
      | { approvalGuard?(): { enabled: boolean } }
      | undefined
    return settings?.approvalGuard?.() ?? { enabled: true }
  }

  /** Strongest matching rule wins: deny, then ask, then allow. */
  private decide(tool: string, subject: ApprovalSubject | undefined) {
    if (!subject) return undefined
    const matched = this.allRules().filter(rule => matchesRule(rule, tool, subject))
    for (const action of ['deny', 'ask', 'allow'] as const) {
      const rule = matched.find(candidate => candidate.action === action)
      if (rule) return { action, rule }
    }
    return undefined
  }

  /**
   * All applicable rules. Deliberately uncached: evaluation happens once per
   * tool call, while a cache keyed on version() is exactly what lets a hot
   * reload serve a stale rule.
   */
  private allRules(): ApprovalRule[] {
    const settings = this.ctx.get('settings', false) as
      | {
          approvalRules?(): ApprovalRule[]
          raw?(): { approval?: { rules?: ApprovalRule[] } }
        }
      | undefined
    const stored = settings?.approvalRules?.() ?? settings?.raw?.().approval?.rules ?? []
    const sources = [...this.sources.values()].sort((a, b) => b.priority - a.priority)
    return [...sources.flatMap(source => [...source.rules()]), ...stored, ...this.granted]
  }

  /**
   * Persist "always allow" as an exact-match rule. Settings mutates its
   * in-memory data before awaiting, so the next tool call sees the rule even
   * though the write is asynchronous. Escalations are never persisted.
   */
  private remember(request: ApprovalRequest) {
    if (request.kind === 'escalation') return
    if (!request.subject) {
      this.always.add(`${request.sessionId}:${request.tool}`)
      return
    }
    // A guarded command is confirmed every time; "always" must not weaken it.
    if (request.guard) return

    const rule = exactRule(request.tool, request.subject)
    const settings = this.ctx.get('settings', false) as
      | { upsertApprovalRule?(input: { tool: string; match: string; pattern: string }): Promise<unknown> }
      | undefined
    const persisted = settings?.upsertApprovalRule?.({ tool: rule.tool, match: rule.match, pattern: rule.pattern })
    if (!persisted) {
      this.granted.push(rule)
      return
    }
    void persisted.catch((error) => {
      this.ctx.logger('approval').warn(error)
      this.granted.push(rule)
    })
  }
}

export default ApprovalService

export const meta = {
  title: '审批服务',
  description: '危险操作与沙箱升级的人工确认、规则源与 fail-closed 截止时间。',
}
