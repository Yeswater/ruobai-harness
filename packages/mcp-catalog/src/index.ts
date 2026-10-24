import type { Context } from '@ruobai/cordis'
import type { McpServerDefinition } from '@ruobai/mcp'
import type {} from '@ruobai/settings'

export const name = 'mcp-catalog'
export const inject = ['settings', 'mcp']

/**
 * Makes settings the source of truth for MCP connections.
 *
 * Every settings commit re-runs the diff: new servers connect, changed ones
 * reconnect, removed or disabled ones disconnect. Syncs are serialized so a
 * burst of edits cannot interleave reconciliations.
 */
export function apply(ctx: Context) {
  let queue: Promise<void> = Promise.resolve()

  const sync = () => {
    const servers: McpServerDefinition[] = ctx.settings.mcpServers()
      .filter(entry => !entry.disabled)
      .map(entry => ({
        id: entry.id,
        label: entry.label,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd: entry.cwd,
        timeoutMs: entry.timeoutMs,
        approval: entry.approval,
        restart: entry.restart,
      }))

    queue = queue
      .then(() => ctx.mcp.sync(servers))
      .catch(error => ctx.logger('mcp-catalog').error(error))
  }

  ctx.effect(() => ctx.on('settings/updated', sync), 'mcp-catalog.settings')
  sync()
}

export default { name, inject, apply }

export const meta = {
  title: 'MCP 目录',
  description: '根据设置维护 MCP 服务器连接。',
}
