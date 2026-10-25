import type { Context } from '@ruobai/cordis'
import type { McpApproval, McpServerDefinition } from '@ruobai/mcp'
import type { McpFileServer } from '@ruobai/mcp-config'
import type {} from '@ruobai/settings'
import type {} from '@ruobai/mcp-config'

export interface SettingsMcpServer {
  id: string
  label?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  approval?: McpApproval
  restart?: boolean
  disabled?: boolean
}

/**
 * File entries win id conflicts. A disabled file entry still claims its id, so
 * the same server from settings is not re-added.
 */
export function mergeServers(
  files: McpFileServer[],
  settings: SettingsMcpServer[],
): McpServerDefinition[] {
  const taken = new Set(files.map(server => server.id))
  const servers: McpServerDefinition[] = files
    .filter(server => !server.disabled)
    .map(({ source: _source, filePath: _file, disabled: _disabled, ...rest }) => rest)
  for (const entry of settings) {
    if (entry.disabled || taken.has(entry.id)) continue
    taken.add(entry.id)
    servers.push({
      id: entry.id,
      label: entry.label,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
      timeoutMs: entry.timeoutMs,
      approval: entry.approval,
      restart: entry.restart,
    })
  }
  return servers
}

export const name = 'mcp-catalog'
export const inject = ['settings', 'mcp', 'mcpConfig']

/**
 * Reconciles MCP connections from three sources: config files, then settings.
 * File entries win id conflicts, and a disabled file entry masks the matching
 * settings server. Every settings commit or config-file change re-runs the
 * diff; syncs are serialized so bursts cannot interleave.
 */
export function apply(ctx: Context) {
  let queue: Promise<void> = Promise.resolve()

  const sync = async () => {
    try {
      const files = await ctx.mcpConfig.servers()
      const servers = mergeServers(files, ctx.settings.mcpServers())

      queue = queue
        .then(() => ctx.mcp.sync(servers))
        .catch(error => ctx.logger('mcp-catalog').error(error))
    } catch (error) {
      ctx.logger('mcp-catalog').error(error)
    }
  }

  ctx.effect(() => ctx.on('settings/updated', () => { void sync() }), 'mcp-catalog.settings')
  ctx.effect(() => ctx.on('mcp-config/changed', () => { void sync() }), 'mcp-catalog.files')
  void sync()
}

export default { name, inject, apply }

export const meta = {
  title: 'MCP 目录',
  description: '合并配置文件与设置，维护 MCP 服务器连接。',
}
