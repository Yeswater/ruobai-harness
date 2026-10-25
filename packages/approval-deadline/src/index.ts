import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

export interface Config {
  /** Milliseconds before an unanswered request is denied. Clamped to [5s, 10min]. */
  timeoutMs?: number
}

/**
 * Tunes the approval deadline. Deliberately a knob, not a switch: the
 * fail-closed behaviour itself lives in `ApprovalService` and cannot be
 * disabled by removing or reconfiguring a plugin.
 */
export default class ApprovalDeadline {
  static inject = ['approval']

  static Config: z<Config> = z.object({
    timeoutMs: z.number().min(5_000).max(600_000).default(180_000),
  })

  constructor(ctx: Context, config: Config = {}) {
    ctx.effect(
      () => ctx.approval.setDeadlinePolicy({ timeoutMs: config.timeoutMs ?? 180_000 }),
      'approval.deadline',
    )
  }
}

export const meta = {
  title: '审批截止时间',
  description: '调整审批超时；超时后一律拒绝。',
}
