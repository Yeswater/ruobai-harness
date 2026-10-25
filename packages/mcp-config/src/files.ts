import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { McpServerDefinition } from '@ruobai/mcp'

export interface McpFileServer extends McpServerDefinition {
  source: 'file'
  filePath: string
  /** A disabled entry still claims its id, masking lower-priority sources. */
  disabled?: boolean
}

export interface ConfigFileSource {
  path: string
  label: string
}

/** Config files in precedence order: workspace root, project .ruobai, global. */
export function configFiles(workspaceRoot: string, globalRoot: string): ConfigFileSource[] {
  return [
    { path: join(workspaceRoot, '.mcp.json'), label: '.mcp.json' },
    { path: join(workspaceRoot, '.ruobai', 'mcp.json'), label: '.ruobai/mcp.json' },
    { path: join(globalRoot, 'mcp.json'), label: '~/.ruobai/mcp.json' },
  ]
}

/**
 * Reads one MCP config file. Accepts Claude's `{ mcpServers: {...} }` map and
 * the harness-native `{ servers: [...] }` list.
 */
export async function readConfigFile(filePath: string): Promise<McpFileServer[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return []
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object') return []
  const record = data as Record<string, unknown>
  const entries: Array<{ id: string; value: Record<string, unknown> }> = []

  if (record.mcpServers && typeof record.mcpServers === 'object') {
    for (const [id, value] of Object.entries(record.mcpServers as Record<string, unknown>)) {
      if (value && typeof value === 'object') entries.push({ id, value: value as Record<string, unknown> })
    }
  }
  if (Array.isArray(record.servers)) {
    for (const value of record.servers) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      const id = typeof entry.id === 'string' ? entry.id : typeof entry.label === 'string' ? entry.label : ''
      if (id) entries.push({ id, value: entry })
    }
  }

  const baseDir = dirname(filePath)
  const servers: McpFileServer[] = []
  for (const entry of entries) {
    const server = normalizeServer(entry.id, entry.value, filePath, baseDir)
    if (server) servers.push(server)
  }
  return servers
}

function normalizeServer(
  rawId: string,
  value: Record<string, unknown>,
  filePath: string,
  baseDir: string,
): McpFileServer | undefined {
  const id = slug(rawId)
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  if (!id || !command) return undefined
  const args = Array.isArray(value.args)
    ? value.args.filter((arg): arg is string => typeof arg === 'string').slice(0, 64)
    : []
  const env = readEnv(value.env)
  const cwdValue = typeof value.cwd === 'string' ? expandHome(value.cwd.trim()) : ''
  const cwd = cwdValue
    ? isAbsolute(cwdValue) ? cwdValue : resolve(baseDir, cwdValue)
    : baseDir
  const timeout = Number(value.timeoutMs)
  const approval = value.approval === 'auto' || value.approval === 'always' || value.approval === 'never'
    ? value.approval
    : undefined
  return {
    id,
    ...(typeof value.label === 'string' && value.label.trim() ? { label: value.label.trim() } : {}),
    command,
    args,
    ...(env ? { env } : {}),
    cwd,
    ...(Number.isFinite(timeout) ? { timeoutMs: Math.min(Math.max(Math.floor(timeout), 100), 600_000) } : {}),
    ...(approval ? { approval } : {}),
    ...(value.restart === false ? { restart: false } : {}),
    ...(value.disabled === true ? { disabled: true } : {}),
    source: 'file',
    filePath,
  }
}

function readEnv(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = expandEnv(expandHome(item))
  }
  return Object.keys(env).length ? env : undefined
}

export function expandHome(value: string) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

export function expandEnv(value: string) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '')
}

export function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * Merges config files with first-wins id dedupe. A disabled file entry keeps
 * its id so it masks the same server from a lower-priority source.
 */
export function mergeFileServers(
  groups: Array<{ path: string; servers: McpFileServer[] }>,
): McpFileServer[] {
  const taken = new Set<string>()
  const merged: McpFileServer[] = []
  for (const group of groups) {
    for (const server of group.servers) {
      if (taken.has(server.id)) continue
      taken.add(server.id)
      merged.push(server)
    }
  }
  return merged
}
