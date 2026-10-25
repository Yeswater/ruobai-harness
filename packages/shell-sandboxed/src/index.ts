import { randomUUID } from 'node:crypto'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { SandboxRunResult } from '@ruobai/sandbox'
import type { Denial, DenialService } from '@ruobai/sandbox-denial'
import type { SandboxPolicyService } from '@ruobai/sandbox-policy'
import type { EscalationService } from '@ruobai/sandbox-escalation'
import { renderOutput, scrubbedEnv, type ShellRunResult, type ShellRunSpec } from '@ruobai/shell'
import type { Exemption } from '@ruobai/sandbox'

export interface Config {
  /** `auto` escalates relaxable denials; `never` only reports them. */
  escalate?: 'auto' | 'never'
}

function outputOf(result: SandboxRunResult) {
  return { stdout: result.stdout, stderr: result.stderr, truncated: result.truncated }
}

/** The denial block the model actually reads. */
export function renderDenials(denials: readonly Denial[], settled?: { decision: string; attempt: number }) {
  if (!denials.length) return ''
  const lines = ['', '[sandbox] 操作被 macOS Seatbelt 拒绝（不是文件权限不足，sudo 无效）']
  for (const denial of denials) {
    lines.push(`kind: ${denial.kind}`)
    if (denial.guard) lines.push(`guard: ${denial.guard}`)
    if (denial.target) lines.push(`target: ${denial.target}`)
    lines.push(`evidence: ${denial.evidence} (${denial.confidence})`)
  }
  if (settled) lines.push(`decision: ${settled.decision} (attempt ${settled.attempt})`)
  lines.push('请勿重试同一操作；如需该资源，请让用户把它复制进工作区或显式放宽策略。')
  return lines.join('\n')
}

/**
 * Diagnostic form for a run that *succeeded* while something inside it was
 * denied (e.g. `git status | head -5`, where only the tail determines the exit
 * code). No approval is requested — the boundary did not stop the command --
 * but the model must not read a silent partial failure as success.
 */
export function renderDenialNotice(denials: readonly Denial[]) {
  if (!denials.length) return ''
  const parts = denials.map((denial) => {
    const target = denial.target ? ` ${denial.target}` : ''
    return `${denial.kind}${target}`
  })
  return `[sandbox] 命令成功，但其中有操作被拒绝：${parts.join('; ')}（未升级审批）`
}

/** Human/model readable form of one exemption. */
export function describeExemption(exemption: Exemption): string {
  if (exemption.kind === 'guard-read' || exemption.kind === 'guard-write') {
    return `${exemption.kind}:${exemption.guard}`
  }
  return `${exemption.kind}:${exemption.path}`
}

/**
 * The default executor: confines every command through `ctx.sandbox` and turns
 * denials into approvals. Mounting `@ruobai/shell-direct` instead is an
 * explicit opt-out; with neither mounted `tool-bash` fails closed.
 */
export default class SandboxedShell {
  static inject = ['shell', 'sandbox', 'sandboxPolicy', 'denial']

  static Config: z<Config> = z.object({
    escalate: z.union([z.const('auto'), z.const('never')]).default('auto'),
  })

  constructor(ctx: Context, config: Config = {}) {
    const policyService = ctx.get('sandboxPolicy') as SandboxPolicyService
    const denialService = ctx.get('denial') as DenialService
    const escalate = config.escalate ?? 'auto'

    const runOnce = async (spec: ShellRunSpec, relax: readonly Exemption[] = []) => {
      const policy = policyService.forSession({ sessionId: spec.sessionId })
      const result = await ctx.sandbox.execute({
        runId: randomUUID(),
        command: spec.command,
        cwd: spec.cwd,
        policy,
        // Sandboxed commands get the same scrubbed environment as direct ones:
        // Seatbelt does not restrict `env`, so the harness token would
        // otherwise be readable via `echo $RBU_TOKEN`.
        env: scrubbedEnv(),
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        signal: spec.signal,
        sessionId: spec.sessionId,
        ...(relax.length ? { relax } : {}),
      })
      const denials = denialService.classify(result, {
        command: spec.command,
        sessionId: spec.sessionId,
        cwd: spec.cwd,
      })
      return { result, denials, policy }
    }

    ctx.effect(() => ctx.shell.register({
      id: 'sandbox',
      sandboxed: true,
      async run(spec: ShellRunSpec): Promise<ShellRunResult> {
        const attempt = spec.attempt ?? 1
        const first = await runOnce(spec)
        const base: ShellRunResult = {
          content: renderOutput(outputOf(first.result), first.result.exitCode, first.result.signal, first.result.durationMs),
          exitCode: first.result.exitCode,
          signal: first.result.signal,
          durationMs: first.result.durationMs,
          truncated: first.result.truncated,
          denials: first.denials,
          executor: 'sandbox',
          sandboxed: true,
        }
        // A zero exit code means the command as a whole was not stopped, so
        // there is nothing to escalate. Start-up noise (dyld probing
        // /dev/dtracehelper) is filtered out earlier, but a denial *inside* a
        // successful command (e.g. `git status | head -5`) must still be
        // surfaced as a diagnostic: a silent partial failure reads as success.
        if (!first.denials.length) return base
        if (first.result.exitCode === 0) {
          return { ...base, content: `${base.content}\n${renderDenialNotice(first.denials)}` }
        }

        // Not the same as "failed": the sandbox blocked it. Always surfacing
        // this block keeps the model from retrying the same path forever.
        const denial = first.denials[0]
        const escalation = ctx.get('escalation', false) as EscalationService | undefined
        if (escalate === 'never' || !escalation) {
          return {
            ...base,
            content: `${base.content}\n${renderDenials(first.denials)}`,
          }
        }

        const outcome = await escalation.escalate(denial, {
          sessionId: spec.sessionId,
          attempt,
          signal: spec.signal,
        })
        if (!outcome.approved || !outcome.exemption) {
          return {
            ...base,
            content: `${base.content}\n${renderDenials(first.denials, { decision: outcome.reason, attempt })}`,
          }
        }

        const second = await runOnce(spec, [outcome.exemption])
        const relaxed = describeExemption(outcome.exemption)
        const content = renderOutput(outputOf(second.result), second.result.exitCode, second.result.signal, second.result.durationMs)
        const settled = renderDenials(second.denials, { decision: 'approved', attempt: attempt + 1 })
        return {
          content: [
            `[sandbox] 本次放宽：${relaxed}（仅此一次，未写入策略）`,
            content,
            second.denials.length && second.result.exitCode !== 0 ? settled : '',
          ].filter(Boolean).join('\n'),
          exitCode: second.result.exitCode,
          signal: second.result.signal,
          durationMs: second.result.durationMs,
          truncated: second.result.truncated,
          denials: second.denials,
          executor: 'sandbox',
          sandboxed: true,
          relaxed: [relaxed],
        }
      },
    }, { default: true }), 'shell.sandboxed')
  }
}

export const meta = {
  title: '沙箱 Shell',
  description: '经 Seatbelt 执行命令，并把拒绝升级为审批。',
}
