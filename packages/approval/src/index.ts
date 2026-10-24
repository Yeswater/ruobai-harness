import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import type { ApprovalRule } from '@ruobai/settings'
import { builtinDangerRules, dangerFor } from './danger.ts'
import { exactRule, matchesRule, type ApprovalSubject } from './rules.ts'

export type { ApprovalSubject } from './rules.ts'
export type { DangerMatch, DangerRule } from './danger.ts'
export { builtinDangerRules, DANGER_RULES, dangerFor } from './danger.ts'

export type ApprovalDecision = 'allow' | 'always' | 'deny'

export interface ApprovalPreview {
  summary: string
  diff?: string
}

export interface ApprovalRequest extends ApprovalPreview {
  id: string
  sessionId: string
  tool: string
  args: unknown
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

declare module '@ruobai/cordis' {
  interface Context {
    approval: ApprovalService
  }

  interface Events {
    'approval/requested'(request: ApprovalRequest): void
    'approval/resolved'(resolution: ApprovalResolution): void
  }
}

export interface ApprovalRequestInput extends ApprovalPreview {
  sessionId: string
  tool: string
  args: unknown
  subject?: ApprovalSubject
}

/**
 * Blocks mutating tool calls until a human (or a bypass setting) decides.
 *
 * Decisions default to deny when the turn is aborted or the service unloads.
 * "always" is scoped to one session + tool for the process lifetime.
 */
export class ApprovalService extends Service {
  private readonly pending = new Map<string, { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void }>()
  private readonly always = new Set<string>()
  /** Rules granted in this process when settings cannot persist them. */
  private readonly granted: ApprovalRule[] = []

  constructor(ctx: Context) {
    super(ctx, 'approval')
    ctx.effect(() => () => {
      this.denyAll()
      this.granted.length = 0
    }, 'approval.dispose')
  }

  /** True when settings opt out of approvals entirely. */
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

  async request(input: ApprovalRequestInput, run: { signal?: AbortSignal } = {}): Promise<ApprovalDecision> {
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
    const danger = guard.enabled && mode !== 'full-access' && input.subject?.kind === 'command'
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
      const modeDecision = permissions?.approval(input.sessionId, input.tool, input.subject)
      if (modeDecision === 'deny') return 'deny'
      if (modeDecision === 'allow') return 'allow'
      if (policy?.action === 'allow') return 'allow'
      if (this.bypassed()) return 'allow'

      // Tools without a subject (MCP) keep the old session+tool grant.
      const key = `${input.sessionId}:${input.tool}`
      if (!input.subject && this.always.has(key)) return 'allow'
    }

    const request: ApprovalRequest = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...input,
      ...(forced ? { guard: forced } : {}),
    }

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(request.id, { request, resolve })
      run.signal?.addEventListener('abort', () => {
        if (this.pending.has(request.id)) this.resolve(request.id, 'deny')
      }, { once: true })
      this.ctx.emit('approval/requested', request)
    })

    return decision
  }

  resolve(id: string, decision: ApprovalDecision) {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    if (decision === 'always') this.remember(entry.request)
    this.ctx.emit('approval/resolved', { id, decision, request: entry.request })
    entry.resolve(decision)
    return true
  }

  denyAll(sessionId?: string) {
    for (const request of this.list(sessionId)) this.resolve(request.id, 'deny')
  }

  /** Built-in danger rules, surfaced in settings. */
  dangerous() {
    return builtinDangerRules()
  }

  private guard(): { enabled: boolean } {
    const settings = this.ctx.get('settings', false) as
      | { approvalGuard?(): { enabled: boolean } }
      | undefined
    return settings?.approvalGuard?.() ?? { enabled: true }
  }

  /** Strongest matching user rule wins: deny, then ask, then allow. */
  private decide(tool: string, subject: ApprovalSubject | undefined) {
    if (!subject) return undefined
    const matched = this.rules().filter(rule => matchesRule(rule, tool, subject))
    for (const action of ['deny', 'ask', 'allow'] as const) {
      const rule = matched.find(candidate => candidate.action === action)
      if (rule) return { action, rule }
    }
    return undefined
  }

  private rules(): ApprovalRule[] {    const settings = this.ctx.get('settings', false) as
      | {
          approvalRules?(): ApprovalRule[]
          raw?(): { approval?: { rules?: ApprovalRule[] } }
        }
      | undefined
    const stored = settings?.approvalRules?.() ?? settings?.raw?.().approval?.rules ?? []
    return [...stored, ...this.granted]
  }

  /**
   * Persist "always allow" as an exact-match rule. Settings mutates its
   * in-memory data before awaiting, so the next tool call sees the rule even
   * though the write is asynchronous.
   */
  private remember(request: ApprovalRequest) {
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
