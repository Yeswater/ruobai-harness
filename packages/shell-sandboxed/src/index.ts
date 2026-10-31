import { randomUUID } from 'node:crypto'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import {
  DEFAULT_EXCLUDED_COMMANDS,
  isExcludedCommand,
  type SandboxRunResult,
} from '@ruobai/sandbox'
import type { Denial, DenialService } from '@ruobai/sandbox-denial'
import type { SandboxPolicyService } from '@ruobai/sandbox-policy'
import type { SandboxProxyService } from '@ruobai/sandbox-proxy'
import { renderOutput, scrubbedEnv, ShellUnavailableError, type ShellRunResult, type ShellRunSpec } from '@ruobai/shell'
import type { SettingsService } from '@ruobai/settings'

export interface Config {
  /**
   * Extra commands that always run outside the sandbox. Added to the user's
   * `sandbox.excludedCommands`.
   */
  excludedCommands?: string[]
}

function outputOf(result: SandboxRunResult) {
  return { stdout: result.stdout, stderr: result.stderr, truncated: result.truncated }
}

export interface DenialGuidance {
  /** Whether the user allows a retry outside the sandbox. */
  allowUnsandboxed?: boolean
}

/** The denial block the model actually reads. */
export function renderDenials(denials: readonly Denial[], guidance: DenialGuidance = {}) {
  if (!denials.length) return ''
  const lines = ['', '[sandbox] 操作被 macOS Seatbelt 拒绝（不是文件权限不足，sudo 无效）']
  for (const denial of denials) {
    lines.push(`kind: ${denial.kind}`)
    if (denial.guard) lines.push(`guard: ${denial.guard}`)
    if (denial.target) lines.push(`target: ${denial.target}`)
    lines.push(`evidence: ${denial.evidence} (${denial.confidence})`)
  }
  if (denials.some(denial => denial.kind === 'network-outbound')) {
    lines.push('网络请求被沙箱拦截。允许的域名在 设置 → 沙箱 → 允许的域名 中维护；沙箱内只有该列表和本地回环可达。')
  }
  lines.push(
    guidance.allowUnsandboxed === false
      ? '请勿重试同一操作；请让用户在 设置 → 沙箱 中调整策略，或把所需资源复制进工作区。'
      : '不要原样反复重试：说明原因后可请用户批准，再用 bash 的 dangerouslyDisableSandbox: true 重跑一次，或在 设置 → 沙箱 中放宽策略。',
  )
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

/** Proxy-level denials leave no kernel record; name the hosts explicitly. */
export function renderProxyDenials(hosts: readonly string[]) {
  if (!hosts.length) return ''
  return `\n[sandbox] 沙箱代理拒绝了网络请求：${hosts.join(', ')}。可在 设置 → 沙箱 → 允许的域名 中添加，或经批准后不经沙箱重试。`
}

interface SandboxUserSettings {
  allowUnsandboxedCommands?: boolean
  excludedCommands?: string[]
}

/**
 * The default executor: confines every command through `ctx.sandbox`.
 *
 * The boundary is the security decision, so a command that stays inside it
 * runs without an approval prompt (the approval policy decides that). Only
 * commands that leave the sandbox — explicitly requested, or listed in
 * `excludedCommands` — go through the direct executor.
 */
export default class SandboxedShell {
  static inject = ['shell', 'sandbox', 'sandboxPolicy', 'denial']

  static Config: z<Config> = z.object({
    excludedCommands: z.array(z.string()).default([]),
  })

  constructor(ctx: Context, config: Config = {}) {
    const policyService = ctx.get('sandboxPolicy') as SandboxPolicyService
    const denialService = ctx.get('denial') as DenialService
    const settings = () => (ctx.get('settings', false) as SettingsService | undefined)?.get().sandbox as
      | SandboxUserSettings
      | undefined

    const runDirect = async (spec: ShellRunSpec, note: string): Promise<ShellRunResult> => {
      const direct = ctx.shell.executor('direct')
      if (!direct) {
        throw new ShellUnavailableError('this command needs the direct executor, which is not registered')
      }
      const result = await direct.run(spec)
      return {
        ...result,
        executor: 'direct',
        sandboxed: false,
        content: `[sandbox] ${note}\n${result.content}`,
      }
    }

    const runOnce = async (spec: ShellRunSpec) => {
      // Resolved per run so a settings change or a proxy restart applies at once.
      const proxy = ctx.get('sandboxProxy', false) as SandboxProxyService | undefined
      const policy = policyService.forSession({
        sessionId: spec.sessionId,
        ...(proxy?.active ? { proxyPort: proxy.port } : {}),
      })
      const env: NodeJS.ProcessEnv = {
        ...scrubbedEnv(),
        // The marker lets a confined process know it cannot, for example,
        // signal its own process group — that permission belongs to the harness.
        RBU_SANDBOX_ACTIVE: '1',
      }
      if (policy.net.mode === 'proxy' && proxy?.active) Object.assign(env, proxy.env())

      const result = await ctx.sandbox.execute({
        runId: randomUUID(),
        command: spec.command,
        cwd: spec.cwd,
        policy,
        env,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        signal: spec.signal,
        sessionId: spec.sessionId,
      })
      const denials = denialService.classify(result, {
        command: spec.command,
        sessionId: spec.sessionId,
        cwd: spec.cwd,
      })
      return { result, denials }
    }

    ctx.effect(() => ctx.shell.register({
      id: 'sandbox',
      sandboxed: true,
      async run(spec: ShellRunSpec): Promise<ShellRunResult> {
        // The settings switch is evaluated per run, so enabling or disabling
        // the sandbox never needs a restart.
        const current = settings()
        const sandboxOff = (ctx.get('settings', false) as SettingsService | undefined)?.sandboxEnabled() === false
        if (sandboxOff) {
          return runDirect(spec, '沙箱已关闭，命令直连执行。')
        }

        const excluded = current?.excludedCommands
          ?? [...DEFAULT_EXCLUDED_COMMANDS, ...(config.excludedCommands ?? [])]
        const requested = spec.sandbox === false
        const excludedCommand = !requested && isExcludedCommand(spec.command, excluded)
        if (requested || excludedCommand) {
          if (current?.allowUnsandboxedCommands === false) {
            return {
              content: '[sandbox] 该命令需要不经沙箱执行，但设置已禁止（allowUnsandboxedCommands=false）。请在 设置 → 沙箱 中允许，或改用沙箱内可完成的命令。',
              exitCode: 1,
              signal: null,
              durationMs: 0,
              truncated: false,
              denials: [],
              executor: 'sandbox',
              sandboxed: true,
            }
          }
          return runDirect(
            spec,
            requested ? '按请求未经沙箱执行。' : '该命令在排除列表中，未经沙箱执行。',
          )
        }

        const startedAt = Date.now()
        const first = await runOnce(spec)
        const proxy = ctx.get('sandboxProxy', false) as SandboxProxyService | undefined
        const proxyNote = renderProxyDenials(proxy?.deniedSince(startedAt) ?? [])
        const base: ShellRunResult = {
          content: renderOutput(outputOf(first.result), first.result.exitCode, first.result.signal, first.result.durationMs) + proxyNote,
          exitCode: first.result.exitCode,
          signal: first.result.signal,
          durationMs: first.result.durationMs,
          truncated: first.result.truncated,
          denials: first.denials,
          executor: 'sandbox',
          sandboxed: true,
        }
        if (!first.denials.length) return base
        if (first.result.exitCode === 0) {
          return { ...base, content: `${base.content}\n${renderDenialNotice(first.denials)}` }
        }
        return {
          ...base,
          content: `${base.content}\n${renderDenials(first.denials, {
            allowUnsandboxed: current?.allowUnsandboxedCommands !== false,
          })}`,
        }
      },
    }, { default: true }), 'shell.sandboxed')
  }
}

export const meta = {
  title: '沙箱 Shell',
  description: '沙箱内命令免审批执行；越过沙箱时经审批走直连。',
}
