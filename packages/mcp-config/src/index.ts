import { unwatchFile, watchFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import {
  configFiles, mergeFileServers, readConfigFile, type ConfigFileSource, type McpFileServer,
} from './files.ts'

export type { McpFileServer } from './files.ts'
export { mergeFileServers, readConfigFile, slug } from './files.ts'

export interface Config {
  /** Workspace whose `.mcp.json` and `.ruobai/mcp.json` are read. */
  workspaceRoot?: string
  /** User-global directory; defaults to ~/.ruobai. */
  globalRoot?: string
  /** Poll interval for config files; 0 disables watching. */
  watchIntervalMs?: number
}

declare module '@ruobai/cordis' {
  interface Context {
    mcpConfig: McpConfigService
  }

  interface Events {
    'mcp-config/changed'(): void
  }
}

/**
 * File-based MCP servers. Settings remain a source; `mcp-catalog` merges both
 * and treats file entries as higher priority.
 */
export class McpConfigService extends Service {
  static Config: z<Config> = z.object({
    workspaceRoot: z.string(),
    globalRoot: z.string(),
    watchIntervalMs: z.number().min(0).default(1_000),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'mcpConfig')
    const interval = this.config.watchIntervalMs ?? 1_000
    if (interval <= 0) return
    ctx.effect(() => {
      const files = this.sources().map(source => source.path)
      for (const file of files) {
        watchFile(file, { interval, persistent: false }, () => ctx.emit('mcp-config/changed'))
      }
      return () => {
        for (const file of files) unwatchFile(file)
      }
    }, 'mcp-config.watch')
  }

  sources(): ConfigFileSource[] {
    const workspaceRoot = this.config.workspaceRoot ?? process.cwd()
    const globalRoot = this.config.globalRoot ?? join(homedir(), '.ruobai')
    return configFiles(workspaceRoot, globalRoot)
  }

  /** Merged file servers in precedence order (workspace beats global). */
  async servers(): Promise<McpFileServer[]> {
    return mergeFileServers(await this.groups())
  }

  /** Per-file view for the protocols page. */
  async info() {
    return Promise.all(this.sources().map(async source => ({
      ...source,
      count: (await readConfigFile(source.path)).length,
    })))
  }

  private async groups() {
    const groups: Array<{ path: string; servers: McpFileServer[] }> = []
    for (const source of this.sources()) {
      groups.push({ path: source.path, servers: await readConfigFile(source.path) })
    }
    return groups
  }
}

export default McpConfigService

export const meta = {
  title: 'MCP 配置文件',
  description: '读取 .mcp.json 与 .ruobai/mcp.json 并合并 MCP 服务器。',
}
