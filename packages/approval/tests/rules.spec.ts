import { describe, expect, it } from 'vitest'
import type { ApprovalRule } from '@ruobai/settings'
import { matchesRule } from '../src/rules.ts'

function rule(overrides: Partial<ApprovalRule>): ApprovalRule {
  return { id: 'r', tool: 'bash', match: 'exact', pattern: '', action: 'allow', createdAt: 0, ...overrides }
}

const command = (value: string) => ({ kind: 'command' as const, value })
const path = (value: string) => ({ kind: 'path' as const, value })

describe('approval rule matching', () => {
  it('matches exact commands and paths', () => {
    expect(matchesRule(rule({ pattern: 'pnpm test' }), 'bash', command('  pnpm test '))).toBe(true)
    expect(matchesRule(rule({ pattern: 'pnpm test' }), 'bash', command('pnpm test --watch'))).toBe(false)
    expect(matchesRule(rule({ tool: 'write_file', pattern: 'src/a.ts' }), 'write_file', path('./src/a.ts'))).toBe(true)
  })

  it('matches command prefixes on word boundaries only', () => {
    const prefix = rule({ match: 'prefix', pattern: 'pnpm test' })
    expect(matchesRule(prefix, 'bash', command('pnpm test --watch'))).toBe(true)
    expect(matchesRule(prefix, 'bash', command('pnpm testing'))).toBe(false)
    expect(matchesRule(prefix, 'bash', command('pnpm'))).toBe(false)
  })

  it('never lets a prefix rule through a chained or expanded command', () => {
    const prefix = rule({ match: 'prefix', pattern: 'ls' })
    const attacks = [
      'ls; rm -rf /',
      'ls && rm -rf /',
      'ls || rm -rf /',
      'ls | cat',
      'ls > out',
      'ls < in',
      'ls $(rm -rf /)',
      'ls `rm -rf /`',
      'ls\nrm -rf /',
      'ls \\\nrm -rf /',
    ]
    for (const attack of attacks) {
      expect(matchesRule(prefix, 'bash', command(attack)), attack).toBe(false)
    }
  })

  it('allows an exact rule to contain operators', () => {
    expect(matchesRule(rule({ pattern: 'echo hi && ls' }), 'bash', command('echo hi && ls'))).toBe(true)
  })

  it('matches path globs without crossing directories', () => {
    const flat = rule({ tool: 'write_file', match: 'glob', pattern: 'src/*.ts' })
    expect(matchesRule(flat, 'write_file', path('src/a.ts'))).toBe(true)
    expect(matchesRule(flat, 'write_file', path('src/deep/a.ts'))).toBe(false)

    const deep = rule({ tool: 'write_file', match: 'glob', pattern: 'src/**/*.ts' })
    expect(matchesRule(deep, 'write_file', path('src/deep/a.ts'))).toBe(true)
    expect(matchesRule(deep, 'write_file', path('src/a.ts'))).toBe(true)
  })

  it('matches contains literally, collapsing whitespace for commands', () => {
    const contains = rule({ match: 'contains', pattern: 'git   push' })
    expect(matchesRule(contains, 'bash', command('git push origin main'))).toBe(true)
    expect(matchesRule(contains, 'bash', command('git pull'))).toBe(false)

    const pathContains = rule({ tool: 'write_file', match: 'contains', pattern: '.env' })
    expect(matchesRule(pathContains, 'write_file', path('config/.env.local'))).toBe(true)
  })

  it('does not let contains allow rules through chained commands', () => {
    const allow = rule({ match: 'contains', pattern: 'pnpm test', action: 'allow' })
    expect(matchesRule(allow, 'bash', command('pnpm test --run'))).toBe(true)
    expect(matchesRule(allow, 'bash', command('pnpm test && rm -rf /'))).toBe(false)

    const ask = rule({ match: 'contains', pattern: 'pnpm test', action: 'ask' })
    expect(matchesRule(ask, 'bash', command('pnpm test && rm -rf /'))).toBe(true)

    const denyPrefix = rule({ match: 'prefix', pattern: 'git push --force', action: 'deny' })
    expect(matchesRule(denyPrefix, 'bash', command('git push --force && rm -rf /'))).toBe(true)
  })

  it('requires the tool and a subject to match', () => {
    expect(matchesRule(rule({ pattern: 'x' }), 'write_file', command('x'))).toBe(false)
    expect(matchesRule(rule({ pattern: 'x' }), 'bash', undefined)).toBe(false)
  })
})
