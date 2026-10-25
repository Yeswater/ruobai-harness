import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type A2aApproval = 'auto' | 'always' | 'never'

export interface A2aAgentConfig {
  id: string
  name?: string
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
  approval?: A2aApproval
  disabled?: boolean
  allowPrivateHosts?: boolean
  readOnly?: boolean
}

export interface A2aConfigFile {
  path: string
  agents: A2aAgentConfig[]
}

export function a2aConfigFiles(workspaceRoot: string, globalRoot: string) {
  return [
    join(workspaceRoot, '.ruobai', 'a2a.json'),
    join(globalRoot, 'a2a.json'),
  ]
}

/** Reads one config file; malformed files contribute nothing. */
export async function readA2aConfig(filePath: string): Promise<A2aAgentConfig[]> {
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
  const agents = (data as { agents?: unknown })?.agents
  if (!Array.isArray(agents)) return []
  const result: A2aAgentConfig[] = []
  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const url = typeof value.url === 'string' ? value.url.trim() : ''
    if (!url) continue
    const id = slug(typeof value.id === 'string' ? value.id : typeof value.name === 'string' ? value.name : url)
    if (!id) continue
    const headers = readHeaders(value.headers)
    const timeout = Number(value.timeoutMs)
    result.push({
      id,
      ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}),
      url,
      ...(headers ? { headers } : {}),
      ...(Number.isFinite(timeout) ? { timeoutMs: Math.min(Math.max(Math.floor(timeout), 1_000), 600_000) } : {}),
      ...(value.approval === 'auto' || value.approval === 'always' || value.approval === 'never'
        ? { approval: value.approval }
        : {}),
      ...(value.disabled === true ? { disabled: true } : {}),
      ...(value.allowPrivateHosts === true ? { allowPrivateHosts: true } : {}),
      ...(value.readOnly === true ? { readOnly: true } : {}),
    })
  }
  return result
}

/** Project file overrides global entries with the same id. */
export function mergeA2aConfigs(files: A2aConfigFile[]): A2aAgentConfig[] {
  const seen = new Set<string>()
  const agents: A2aAgentConfig[] = []
  for (const file of files) {
    for (const agent of file.agents) {
      if (seen.has(agent.id)) continue
      seen.add(agent.id)
      agents.push(agent)
    }
  }
  return agents
}

function readHeaders(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const headers: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') continue
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue
    headers[key] = item.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '')
  }
  return Object.keys(headers).length ? headers : undefined
}

export function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\w+:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function defaultGlobalRoot() {
  return join(homedir(), '.ruobai')
}
