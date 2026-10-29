import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractReadyUrl, READY_PREFIX, resolveHarnessCommand } from '../src/harness.ts'

const root = resolve(import.meta.dirname, '../../..')

describe('extractReadyUrl', () => {
  it('reads the URL the CLI prints once the server listens', () => {
    expect(extractReadyUrl(`${READY_PREFIX}http://127.0.0.1:53211`)).toBe('http://127.0.0.1:53211/')
  })

  it('tolerates other output on the same line', () => {
    expect(extractReadyUrl(`12:00 [info] ${READY_PREFIX}http://127.0.0.1:4310`)).toBe('http://127.0.0.1:4310/')
  })

  it('ignores lines without a URL', () => {
    expect(extractReadyUrl(`${READY_PREFIX}starting`)).toBeUndefined()
    expect(extractReadyUrl('[ruobai-harness] started')).toBeUndefined()
    expect(extractReadyUrl(`${READY_PREFIX}ftp://127.0.0.1`)).toBeUndefined()
  })
})

describe('resolveHarnessCommand', () => {
  it('runs the TypeScript CLI through tsx with a free port and the workspace', () => {
    const { command, args } = resolveHarnessCommand({ root, workspace: root, node: 'node' })
    expect(command).toBe('node')
    expect(args[0]).toMatch(/tsx.*cli\.mjs$/)
    expect(args[1]).toBe(resolve(root, 'apps/cli/src/bin.ts'))
    expect(args[2]).toBe(resolve(root, 'cordis.yml'))
    expect(args).toContain('--workspace')
    expect(args.slice(-2)).toEqual(['--port', '0'])
  })

  it('refuses a root without a harness checkout', () => {
    expect(() => resolveHarnessCommand({ root: '/nonexistent-ruobai', workspace: '/tmp' })).toThrow(
      /harness entry not found/,
    )
  })
})
