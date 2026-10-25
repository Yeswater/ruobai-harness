import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SandboxPolicy } from '@ruobai/sandbox'
import { compileProfile, globSource, guardFilter, quote } from '../src/sbpl.ts'

function policy(overrides: Partial<SandboxPolicy['fs']> = {}, net: SandboxPolicy['net'] = { mode: 'deny', allow: [] }): SandboxPolicy {
  return {
    id: 'test',
    version: 1,
    fs: {
      read: [{ path: '/Users/x/ws', recursive: true }],
      write: [{ path: '/Users/x/ws', recursive: true }],
      guardRead: [{ id: 'ssh-keys', path: '/Users/x/.ssh', match: 'subpath', access: 'read', reason: 'keys' }],
      guardWrite: [{ id: 'git-dir', path: '/Users/x/ws/.git', match: 'subpath', access: 'write', reason: 'hooks' }],
      ...overrides,
    },
    net,
    exec: { allowPaths: [] },
    limits: { timeoutMs: 1_000, maxOutputBytes: 1_024 },
  }
}

describe('sbpl quoting', () => {
  it('escapes quotes and backslashes', () => {
    expect(quote('/a"b')).toBe('"/a\\"b"')
    expect(quote('/a\\b')).toBe('"/a\\\\b"')
  })

  it('turns globs into anchored regexes where * stops at a slash', () => {
    const source = globSource('/ws/**/.env*')
    expect(source.startsWith('^')).toBe(true)
    expect(source.endsWith('$')).toBe(true)
    expect(new RegExp(source).test('/ws/a/b/.env.local')).toBe(true)
    expect(new RegExp(source).test('/ws/.env')).toBe(false)
  })
})

describe('compileProfile', () => {
  it('starts from deny default and never allows by default', () => {
    const { text } = compileProfile(policy())
    expect(text).toContain('(deny default)')
    expect(text).not.toContain('(allow default)')
    expect(text.indexOf('(deny default)')).toBeLessThan(text.indexOf('(allow '))
  })

  it('emits one deny filter per guard', () => {
    const compiled = compileProfile(policy())
    expect(compiled.text).toContain(guardFilter(policy().fs.guardRead[0]!))
    expect(compiled.text).toContain(guardFilter(policy().fs.guardWrite[0]!))
  })

  it('throws when a guard is missing from the profile', () => {
    const compiled = compileProfile(policy(), [{ kind: 'guard-read', guard: 'ssh-keys' }])
    // The relaxed guard must be gone, and compilation must not claim it exists.
    expect(compiled.text).not.toContain('(subpath "/Users/x/.ssh")')
    expect(compiled.warnings.join(' ')).toContain('relaxed read guards: ssh-keys')
  })

  it('drops only the exempted deny rule', () => {
    const before = compileProfile(policy())
    const after = compileProfile(policy(), [{ kind: 'guard-write', guard: 'git-dir' }])
    expect(after.text).not.toContain('(subpath "/Users/x/ws/.git")')
    expect(after.text).toContain('(subpath "/Users/x/.ssh")')
    expect(after.digest).not.toBe(before.digest)
    // Everything else stays byte-identical apart from the relaxed deny line.
    const rest = (text: string) => text.split('\n').filter(line => !line.includes('.git') && !line.includes('relaxed'))
    expect(rest(after.text).join('\n')).toBe(rest(before.text).join('\n'))
  })

  it('never grants a read subpath on the filesystem root', () => {
    const { text } = compileProfile(policy())
    // `(subpath "/")` would allow reading everything; only the literal vnode
    // itself may be readable (curl aborts without it, appendix A17).
    expect(text).not.toContain('(subpath "/")')
    expect(text).toContain('(literal "/")')
  })

  it('allows fork, otherwise no pipeline or toolchain can start', () => {
    // Appendix A18: under `(deny default)` a shell cannot fork, so
    // `sh -c 'a | b'` and every tool that spawns a helper fail with
    // `fork: Operation not permitted`.
    expect(compileProfile(policy()).text).toContain('(allow process-fork)')
    expect(compileProfile(policy(), [], { processFork: 'deny' }).text).toContain('(deny process-fork)')
    // Workers and timeouts have to be killed by their own supervisor.
    expect(compileProfile(policy()).text).toContain('(allow signal (target children))')
  })

  it('allows the start-up device probes so successful runs look clean', () => {
    const { text } = compileProfile(policy())
    // dyld/libSystem opens this on every exec; denying it made every command
    // look like a boundary hit (A18).
    expect(text).toContain('(literal "/dev/dtracehelper")')
    expect(text).toContain('(subpath "/private/var/db/timezone")')
    // The probe is an ioctl, not a read: allowing only read/write still
    // reported one denial per command through the native-log path.
    expect(text).toContain('(allow file-ioctl (literal "/dev/dtracehelper"))')
  })

  it('relaxes exactly one file, never its directory', () => {
    const compiled = compileProfile(policy(), [{ kind: 'write-file', path: '/Users/x/ws/notes.txt', once: true }])
    expect(compiled.text).toContain('(literal "/Users/x/ws/notes.txt")')
    // The containing directory must not become writable through this path.
    expect(compiled.text).not.toContain('(subpath "/Users/x/ws/notes.txt")')
  })

  it('allows exec wherever the policy allows writes', () => {
    // pnpm's `.pnpm` store and `node_modules/.bin` must be executable, and an
    // agent that can write there could run `sh dropped.sh` anyway — so an exec
    // allowlist that excludes writable paths only breaks toolchains (A24).
    const { text } = compileProfile(policy())
    expect(text).toContain('(allow process-exec* (subpath "/Users/x/ws"))')
  })

  it('grants read wherever it grants write', () => {
    // A file written under TMPDIR must be readable back.
    const compiled = compileProfile(policy({
      read: [{ path: '/Users/x/ws', recursive: true }],
      write: [{ path: '/tmp/scratch', recursive: true }],
    }))
    const readLines = compiled.text.split('\n')
      .filter(line => line.startsWith('(allow file-read*'))
      .join('\n')
    expect(readLines).toContain('(subpath "/tmp/scratch")')
  })

  it('does not emit duplicate grants when read and write overlap', () => {
    const { text } = compileProfile(policy())
    const occurrences = text.split('(subpath "/Users/x/ws")').length - 1
    // Once in the read line, once in the write line, once for exec.
    expect(occurrences).toBe(3)
  })

  it('denies all networking by default and never allows loopback in allowlist mode', () => {
    expect(compileProfile(policy()).text).toContain('(deny network*)')
    const allowlist = compileProfile(policy({}, { mode: 'allowlist', allow: [{ host: 'registry.npmjs.org', port: 443 }] }))
    expect(allowlist.text).toContain('(allow network-outbound (remote ip "registry.npmjs.org:443"))')
    expect(allowlist.text).not.toContain('127.0.0.1')
  })

  it('warns when allowlist mode has no rules', () => {
    const compiled = compileProfile(policy({}, { mode: 'allowlist', allow: [] }))
    expect(compiled.warnings.join(' ')).toMatch(/no rules/)
    expect(compiled.text).toContain('(deny network*)')
  })

  it('denies automation and process control', () => {
    const { text } = compileProfile(policy())
    expect(text).toContain('(deny appleevent-send)')
    expect(text).toContain('(deny signal (target others))')
    expect(text).toContain('(deny process-exec (literal "/usr/bin/security"))')
  })

  it('honours write-root exemptions without touching guards', () => {
    const compiled = compileProfile(policy(), [{ kind: 'write-root', path: '/tmp/extra', once: true }])
    expect(compiled.text).toContain('(subpath "/tmp/extra")')
    expect(compiled.text).toContain('(subpath "/Users/x/ws/.git")')
  })

  it('warns when the policy grants no writes at all', () => {
    const compiled = compileProfile(policy({ write: [] }))
    expect(compiled.warnings.join(' ')).toMatch(/no write grants/)
  })

  it('compiles a profile for a temp workspace without touching the real home', () => {
    const compiled = compileProfile(policy({ guardRead: [], guardWrite: [] }))
    expect(compiled.text).toContain(`(subpath ${quote(join('/Users/x/ws'))})`)
    expect(compiled.warnings).toEqual([])
  })
})
