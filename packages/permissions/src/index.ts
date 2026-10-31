import { Service, type Context } from '@ruobai/cordis'
import { DEFAULT_EXCLUDED_COMMANDS, isExcludedCommand } from '@ruobai/sandbox'
import type { PermissionMode } from '@ruobai/settings'
import type { ToolDefinition } from '@ruobai/tools'
import type {} from '@ruobai/session'

export type { PermissionMode } from '@ruobai/settings'

export interface SandboxApprovalSettings {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  excludedCommands?: string[]
}

/**
 * A bash command that stays inside the sandbox is its own security decision;
 * prompting on top of it is what makes the sandbox feel unusable.
 */
export function autoAllowSandboxedBash(input: {
  sandbox?: SandboxApprovalSettings
  command?: string
  args?: unknown
  sandboxAvailable: boolean
}): boolean {
  const { sandbox } = input
  if (!input.sandboxAvailable) return false
  if (sandbox?.enabled === false) return false
  if (sandbox?.autoAllowBashIfSandboxed === false) return false
  if (input.args && typeof input.args === 'object'
    && (input.args as { dangerouslyDisableSandbox?: unknown }).dangerouslyDisableSandbox === true) {
    return false
  }
  const excluded = sandbox?.excludedCommands ?? DEFAULT_EXCLUDED_COMMANDS
  if (input.command && isExcludedCommand(input.command, excluded)) return false
  return true
}

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
    args?: unknown,
  ): 'allow' | 'deny' | undefined {
    const tool = toolName
      ? (this.ctx.get('tools', false) as { get(name: string): ToolDefinition | undefined } | undefined)
        ?.get(toolName)
      : undefined
    const mode = this.modeFor(sessionId)
    if (mode === 'read-only') return tool?.readOnly ? 'allow' : 'deny'
    if (mode === 'full-access' || mode === 'auto-review') return 'allow'
    if (mode === 'workspace-write' && subject?.kind === 'path') return 'allow'

    if (toolName === 'bash' && subject?.kind === 'command') {
      const settings = this.ctx.get('settings', false) as
        | { get(): { sandbox?: SandboxApprovalSettings } }
        | undefined
      const sandbox = this.ctx.get('sandbox', false) as
        | { provider?(): { available?: boolean } | undefined }
        | undefined
      if (autoAllowSandboxedBash({
        sandbox: settings?.get().sandbox,
        command: subject.value,
        args,
        sandboxAvailable: Boolean(sandbox?.provider?.()),
      })) return 'allow'
    }
    return undefined
  }
}

export default PermissionService

export const meta = {
  title: '权限服务',
  description: '四档权限策略与会话级约束。',
}
