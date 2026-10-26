import { normalizePath } from '@ruobai/lint'
import type { HookGuardSettings } from '@ruobai/settings'

/** Baseline protections; settings may add to them but not remove them. */
export const DEFAULT_DENY_WRITE = [
  '.claude/settings*.json',
  '.ruobai/hooks.json',
  'biome.json',
  'eslint.config.*',
  'tsconfig.json',
  '.github/workflows/*',
]

export const DEFAULT_DENY_COMMAND = [
  'git commit --no-verify',
  'git push --no-verify',
]

export interface GuardCall {
  name: string
  args: Record<string, unknown>
  sessionId?: string
}

export interface GuardDecision {
  deny: true
  reason: string
}

/** `*` stays inside a path segment, `**` crosses segments. */
export function globToRegExp(pattern: string) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
      continue
    }
    source += '\\^$.|?+()[]{}'.includes(char) ? `\\${char}` : char
  }
  return new RegExp(`^${source}$`)
}

export function matchesAny(patterns: string[], value: string) {
  const normalized = value.replace(/^\.\//, '')
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized))
}

/** Targets a shell command would write, so reads of a protected file stay legal. */
function shellWriteTargets(command: string) {
  const targets: string[] = []
  const matcher = /(?:>>?|tee(?:\s+-a)?)\s+(['"]?)([^\s'";|&]+)\1/g
  for (const match of command.matchAll(matcher)) {
    if (match[2]) targets.push(match[2])
  }
  return targets
}

export function guardCall(
  call: GuardCall,
  settings: HookGuardSettings | undefined,
  root: string,
): GuardDecision | undefined {
  if (settings?.enabled === false) return undefined
  const denyWrite = [...DEFAULT_DENY_WRITE, ...(settings?.denyWrite ?? [])]
  const denyCommand = [
    ...DEFAULT_DENY_COMMAND,
    ...(settings?.denyCommand ?? []),
  ]

  if (call.name === 'write_file' || call.name === 'edit_file') {
    const raw = typeof call.args?.path === 'string' ? call.args.path : ''
    if (!raw) return undefined
    const path = normalizePath(raw, root)
    if (matchesAny(denyWrite, path)) {
      return { deny: true, reason: `受保护路径不能修改：${path}` }
    }
    return undefined
  }

  if (call.name === 'bash') {
    const command =
      typeof call.args?.command === 'string' ? call.args.command : ''
    if (!command) return undefined
    const normalized = command.replace(/\s+/g, ' ').toLowerCase()
    for (const fragment of denyCommand) {
      const needle = fragment.replace(/\s+/g, ' ').toLowerCase()
      if (normalized.includes(needle)) {
        return { deny: true, reason: `受保护命令不能执行：${fragment}` }
      }
    }
    for (const target of shellWriteTargets(command)) {
      const path = normalizePath(target, root)
      if (matchesAny(denyWrite, path)) {
        return { deny: true, reason: `命令试图写入受保护路径：${path}` }
      }
    }
  }
  return undefined
}
