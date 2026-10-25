import { sep } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import type { ApprovalDecision, ApprovalService, EscalationSummary } from '@ruobai/approval'
import { NON_RELAXABLE_PREFIXES, type Exemption } from '@ruobai/sandbox'
import { commandFamily, type Denial, type DenialKind } from '@ruobai/sandbox-denial'

export interface Config {
  /** Kinds a human may relax for a single retry. */
  relaxable?: DenialKind[]
  /** Kinds that can never be relaxed, whatever the user answers. */
  neverRelaxable?: DenialKind[]
  /** Commands whose retry is side-effect free (used for the "safe" label). */
  retrySafeCommands?: string[]
  /** Total attempts per run, including the first. */
  maxAttempts?: number
}

export interface EscalationPlan {
  relaxable: boolean
  exemption?: Exemption
  retry: 'safe' | 'unsafe'
  reason: string
}

export interface EscalationOutcome {
  approved: boolean
  decision?: ApprovalDecision
  exemption?: Exemption
  retry: 'safe' | 'unsafe'
  reason: string
}

export interface EscalationRequest {
  sessionId?: string
  attempt: number
  /** Filter used to reuse a session grant. */
  signal?: AbortSignal
}

const CONTROL_CHARACTERS = /[;&|<>`$()\\\n\r]/

/** Hard-coded policy: neither config nor a user answer can relax these. */
const ABSOLUTELY_NOT_RELAXABLE: readonly DenialKind[] = ['network-outbound', 'process-control', 'mach-lookup', 'appleevent']

declare module '@ruobai/cordis' {
  interface Context {
    escalation: EscalationService
  }

  interface Events {
    'sandbox/escalation-requested'(denial: Denial, plan: EscalationPlan): void
    'sandbox/escalation-settled'(denial: Denial, outcome: EscalationOutcome): void
  }
}

/**
 * The bridge between a sandbox denial and an approval request.
 *
 * It depends on `approval` (one direction only). The sandbox core never does,
 * which is what keeps the plugin graph acyclic and both fibers out of PENDING.
 */
export class EscalationService extends Service {
  static inject = ['approval', 'denial']

  private readonly config: Required<Config>
  /** `always` grants: per session, in memory only, dropped with the fiber. */
  private readonly grants = new Map<string, { exemption?: Exemption; retry: 'safe' | 'unsafe' }>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'escalation')
    this.config = {
      relaxable: config.relaxable ?? ['fs-read-guarded', 'fs-write-guarded', 'fs-write-outside'],
      neverRelaxable: config.neverRelaxable ?? [...ABSOLUTELY_NOT_RELAXABLE],
      retrySafeCommands: config.retrySafeCommands ?? ['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'git', 'node'],
      maxAttempts: config.maxAttempts ?? 2,
    }
    ctx.effect(() => () => {
      // Session grants must not survive a reload, otherwise a reload silently
      // widens the boundary.
      this.grants.clear()
    }, 'sandbox-escalation.dispose')
  }

  /** Pure decision: can this denial be relaxed, and how? */
  plan(denial: Denial, attempt: number): EscalationPlan {
    // Low-confidence evidence (no log probe) can never justify an automatic
    // relaxation, so the retry is always labelled unsafe and a human decides.
    const retry = denial.confidence === 'low' ? 'unsafe' as const : this.retrySafety(denial.command)
    const denialKind = denial.kind
    if (ABSOLUTELY_NOT_RELAXABLE.includes(denialKind) || this.config.neverRelaxable.includes(denialKind)) {
      return { relaxable: false, retry, reason: `${denialKind} 永不放宽：需要独立的网络/进程授权流程` }
    }
    if (!this.config.relaxable.includes(denialKind)) {
      return { relaxable: false, retry, reason: `${denialKind} 不在可放宽白名单内` }
    }
    if (attempt >= this.config.maxAttempts) {
      return { relaxable: false, retry, reason: `已达重跑上限（${this.config.maxAttempts}）` }
    }
    if (denial.repeated >= 2) {
      return { relaxable: false, retry, reason: '同一拒绝已重复触发，不再升级' }
    }

    const exemption = this.exemptionFor(denial)
    if (!exemption) {
      return { relaxable: false, retry, reason: '无法把拒绝归因到具体守卫，不能做最小化放宽' }
    }
    const confidence = denial.confidence === 'low' ? '（归因置信度低，需人工确认）' : ''
    return { relaxable: true, exemption, retry, reason: `放宽 ${this.describeExemption(exemption)} 后重跑${confidence}` }
  }

  /**
   * Asks a human to relax one denial for one retry. `neverRelaxable` and the
   * hard-coded list short-circuit before any prompt is shown.
   */
  async escalate(denial: Denial, request: EscalationRequest): Promise<EscalationOutcome> {
    const plan = this.plan(denial, request.attempt)
    const granted = this.grants.get(this.grantKey(denial))

    if (!plan.relaxable && !granted) {
      return { approved: false, retry: plan.retry, reason: plan.reason }
    }
    if (granted && plan.retry !== undefined && this.config.relaxable.includes(denial.kind)) {
      return { approved: true, exemption: granted.exemption, retry: granted.retry, reason: '本会话已授权' }
    }

    const exemption = plan.exemption ?? granted?.exemption
    if (!exemption) {
      return { approved: false, retry: plan.retry, reason: plan.reason }
    }

    this.ctx.emit('sandbox/escalation-requested', denial, plan)
    const approval = this.ctx.get('approval') as ApprovalService
    const escalation: EscalationSummary = {
      kind: denial.kind,
      target: denial.target,
      guard: denial.guard,
      command: denial.command,
      exemption,
      retry: plan.retry,
      attempt: request.attempt,
      evidence: denial.evidence,
      confidence: denial.confidence,
    }
    const decision = await approval.request({
      sessionId: request.sessionId ?? '',
      tool: 'bash',
      args: { command: denial.command },
      kind: 'escalation',
      escalation,
      subject: { kind: 'command', value: denial.command },
      summary: this.summaryOf(denial, plan),
      diff: this.diffOf(denial),
    }, { signal: request.signal })

    if (decision === 'deny') {
      const outcome: EscalationOutcome = { approved: false, decision, retry: plan.retry, reason: '用户拒绝放宽' }
      this.ctx.emit('sandbox/escalation-settled', denial, outcome)
      return outcome
    }

    if (decision === 'always') {
      this.grants.set(this.grantKey(denial), { exemption, retry: plan.retry })
    }
    const outcome: EscalationOutcome = { approved: true, decision, exemption, retry: plan.retry, reason: plan.reason }
    this.ctx.emit('sandbox/escalation-settled', denial, outcome)
    return outcome
  }

  /** Number of session grants, for tests and the UI. */
  grantCount(): number {
    return this.grants.size
  }

  private grantKey(denial: Denial) {
    return `${denial.sessionId ?? ''}:${denial.fingerprint}`
  }

  private exemptionFor(denial: Denial): Exemption | undefined {
    if (denial.kind === 'fs-read-guarded') {
      return denial.guard ? { kind: 'guard-read', guard: denial.guard } : undefined
    }
    if (denial.kind === 'fs-write-guarded') {
      return denial.guard ? { kind: 'guard-write', guard: denial.guard } : undefined
    }
    if (denial.kind === 'fs-write-outside' && denial.target) {
      // Exactly the denied file, never its directory: a denial on
      // `/dev/dtracehelper` must not relax `/dev`. Device nodes and system
      // directories are not relaxation levers at all.
      if (this.nonRelaxable(denial.target)) return undefined
      return { kind: 'write-file', path: denial.target, once: true }
    }
    return undefined
  }

  private nonRelaxable(path: string): boolean {
    const normalized = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path
    if (NON_RELAXABLE_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}${sep}`))) {
      return true
    }
    // Outside the workspace and off the home directory: not a sandbox
    // relaxation a human can meaningfully approve for one retry.
    const policy = this.ctx.get('sandboxPolicy', false) as { root?: string } | undefined
    const root = policy?.root
    if (root && normalized.startsWith(root + sep)) return false
    const home = process.env.HOME
    if (home && (normalized === home || normalized.startsWith(home + sep))) return false
    return true
  }

  private describeExemption(exemption: Exemption) {
    if (exemption.kind === 'write-file') return `文件 ${exemption.path}`
    if (exemption.kind === 'write-root') return `写根 ${exemption.path}`
    return `守卫 ${exemption.guard}`
  }

  private retrySafety(command: string): 'safe' | 'unsafe' {
    if (CONTROL_CHARACTERS.test(command)) return 'unsafe'
    return this.config.retrySafeCommands.includes(commandFamily(command)) ? 'safe' : 'unsafe'
  }

  private summaryOf(denial: Denial, plan: EscalationPlan) {
    const target = denial.target ? ` ${denial.target}` : ''
    return `沙箱拒绝：${denial.kind}${target} · ${plan.reason}`
  }

  private diffOf(denial: Denial) {
    const lines = [
      `$ ${denial.command}`,
      `kind: ${denial.kind}`,
      denial.guard ? `guard: ${denial.guard}` : undefined,
      denial.target ? `target: ${denial.target}` : undefined,
      `evidence: ${denial.evidence} (${denial.confidence})`,
      `exemption: ${denial.guard ?? denial.target ?? 'n/a'}`,
    ]
    return lines.filter(Boolean).join('\n')
  }
}

export default EscalationService

export const meta = {
  title: '沙箱升级桥',
  description: '把沙箱拒绝转成审批请求，并决定重跑是否安全。',
}
