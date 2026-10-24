import { randomUUID } from 'node:crypto'
import type { ApprovalRule } from '@ruobai/settings'

/** What a tool call would be matched against by a persistent rule. */
export interface ApprovalSubject {
  kind: 'command' | 'path'
  value: string
}

/** Shell control and expansion characters that make prefix matching unsafe. */
const CONTROL_CHARACTERS = /[;&|<>`$()\\\n\r]/

export function operatorFree(value: string) {
  return !CONTROL_CHARACTERS.test(value)
}

export function normalizeCommand(value: string) {
  return value.trim()
}

export function normalizePath(value: string) {
  let path = value.trim().replace(/\\/g, '/')
  while (path.startsWith('./')) path = path.slice(2)
  return path === '.' ? '' : path
}

/**
 * Whether a persisted rule permits this tool call.
 *
 * `exact` compares the normalized text; it may contain operators because the
 * whole command has to match. `prefix` refuses any command that could chain or
 * expand, and requires a word boundary. `glob` treats `*` as not crossing `/`
 * for paths, and `**` as crossing directories.
 */
export function matchesRule(rule: ApprovalRule, tool: string, subject: ApprovalSubject | undefined): boolean {
  if (rule.tool !== tool || !subject) return false

  const target = subject.kind === 'command' ? normalizeCommand(subject.value) : normalizePath(subject.value)
  const pattern = rule.match === 'glob' || (rule.match === 'contains' && subject.kind === 'path')
    ? normalizePath(rule.pattern)
    : rule.pattern.trim()
  if (!target || !pattern) return false

  if (rule.match === 'exact') return target === pattern
  if (rule.match === 'prefix') return prefixMatch(target, pattern, subject.kind, rule.action)
  if (rule.match === 'contains') {
    if (subject.kind === 'command') {
      // An allow rule must not be widened by chaining; ask/deny stay strict.
      if (rule.action === 'allow' && (!operatorFree(target) || !operatorFree(pattern))) return false
      return collapse(target).includes(collapse(pattern))
    }
    return target.includes(pattern)
  }
  if (rule.match === 'glob') {
    if (subject.kind === 'command' && rule.action === 'allow'
      && (!operatorFree(target) || !operatorFree(pattern))) return false
    try {
      return globToRegExp(pattern, subject.kind).test(target)
    } catch {
      return false
    }
  }
  return false
}

function collapse(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function prefixMatch(target: string, pattern: string, kind: ApprovalSubject['kind'], action: ApprovalRule['action']) {
  if (kind === 'command' && action === 'allow' && (!operatorFree(target) || !operatorFree(pattern))) return false
  if (!target.startsWith(pattern)) return false
  if (target.length === pattern.length) return true
  const next = target[pattern.length]
  return kind === 'command' ? next === ' ' || next === '\t' : next === '/'
}

export function globToRegExp(pattern: string, kind: ApprovalSubject['kind']) {
  const source = pattern.replace(/\\/g, '/')
  let out = '^'
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (char === '*') {
      if (source[index + 1] === '*') {
        index += 1
        if (source[index + 1] === '/') {
          index += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += kind === 'path' ? '[^/]*' : '.*'
      }
    } else if (char === '?') {
      out += kind === 'path' ? '[^/]' : '.'
    } else {
      out += /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
    }
  }
  return new RegExp(`${out}$`)
}

/** The exact-match rule created when a user clicks "always allow". */
export function exactRule(tool: string, subject: ApprovalSubject): ApprovalRule {
  return {
    id: randomUUID(),
    tool,
    match: 'exact',
    pattern: subject.kind === 'command' ? normalizeCommand(subject.value) : normalizePath(subject.value),
    action: 'allow',
    createdAt: Date.now(),
  }
}
