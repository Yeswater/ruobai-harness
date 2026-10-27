import { Service, type Context } from '@ruobai/cordis'
import type { PermissionMode } from '@ruobai/settings'
import type { ToolDefinition } from '@ruobai/tools'
import type {} from '@ruobai/session'

export type { PermissionMode } from '@ruobai/settings'

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'read-only',
  'workspace-write',
  'full-access',
  'auto-review',
]

export const DEFAULT_PERMISSION: PermissionMode = 'workspace-write'

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

export interface ApprovalSubject {
  kind: 'command' | 'path'
  value: string
}

declare module '@ruobai/cordis' {
  interface Context {
    permissions: PermissionService
  }
}

/**
 * Resolves the per-session permission preset and its tool/approval policy.
 *
 * The presets are enforced in three places: the agent hides unavailable
 * tools, `ToolRegistry.invoke` refuses them, and `ApprovalService` consults
 * `approval()` for the automatic decisions.
 */
export class PermissionService extends Service {
  static inject = ['sessions', 'tools']

  constructor(ctx: Context) {
    super(ctx, 'permissions')
  }

  modeFor(sessionId?: string): PermissionMode {
    const meta = sessionId ? this.ctx.sessions.get(sessionId)?.meta : undefined
    if (isPermissionMode(meta?.permission)) return meta.permission
    const settings = this.ctx.get('settings', false) as
      | { raw(): { agent?: { defaultPermission?: unknown } } }
      | undefined
    const fallback = settings?.raw().agent?.defaultPermission
    if (isPermissionMode(fallback)) return fallback
    return DEFAULT_PERMISSION
  }

  allowsTool(sessionId: string | undefined, tool: ToolDefinition | undefined): boolean {
    if (!tool) return false
    return this.modeFor(sessionId) !== 'read-only' || tool.readOnly === true
  }

  /**
   * Mode-level shortcut for `ApprovalService`: `allow` skips the prompt,
   * `deny` blocks, `undefined` keeps the normal rule flow.
   */
  approval(
    sessionId: string | undefined,
    toolName: string | undefined,
    subject?: ApprovalSubject,
  ): 'allow' | 'deny' | undefined {
    const tool = toolName
      ? (this.ctx.get('tools', false) as { get(name: string): ToolDefinition | undefined } | undefined)
        ?.get(toolName)
      : undefined
    const mode = this.modeFor(sessionId)
    if (mode === 'read-only') return tool?.readOnly ? 'allow' : 'deny'
    if (mode === 'full-access' || mode === 'auto-review') return 'allow'
    if (mode === 'workspace-write' && subject?.kind === 'path') return 'allow'
    return undefined
  }
}

export default PermissionService

export const meta = {
  title: '权限服务',
  description: '四档权限策略与会话级约束。',
}
