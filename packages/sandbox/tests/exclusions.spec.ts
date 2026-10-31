import { describe, expect, it } from 'vitest'
import { commandExecutable, DEFAULT_EXCLUDED_COMMANDS, isExcludedCommand } from '../src/index.ts'

describe('command executable parsing', () => {
  it('unwraps assignments and common wrappers', () => {
    expect(commandExecutable('FOO=1 /usr/bin/git status')).toBe('git')
    expect(commandExecutable('env A=1 B=2 docker ps')).toBe('docker')
    expect(commandExecutable('command npm test')).toBe('npm')
    expect(commandExecutable('timeout 30 pnpm build')).toBe('pnpm')
    expect(commandExecutable('nohup ./server --port 1')).toBe('server')
    expect(commandExecutable("'quoted tool' --flag")).toBe('quoted tool')
  })

  it('keeps shell indirection visible', () => {
    // `sh -c 'docker ps'` is not treated as docker: the boundary sees a shell.
    expect(commandExecutable('sh -c "docker ps"')).toBe('sh')
  })
})

describe('excluded commands', () => {
  it('matches the program, not text inside arguments', () => {
    expect(isExcludedCommand('docker compose up', ['docker'])).toBe(true)
    expect(isExcludedCommand('/usr/local/bin/docker ps', ['docker'])).toBe(true)
    expect(isExcludedCommand('echo docker', ['docker'])).toBe(false)
    expect(isExcludedCommand('git commit -m "docker"', ['docker'])).toBe(false)
  })

  it('supports multi-word prefixes and defaults', () => {
    expect(isExcludedCommand('docker compose up', ['docker compose'])).toBe(true)
    expect(isExcludedCommand('podman ps', DEFAULT_EXCLUDED_COMMANDS)).toBe(true)
    expect(isExcludedCommand('npm test', DEFAULT_EXCLUDED_COMMANDS)).toBe(false)
    expect(isExcludedCommand('npm test', [])).toBe(false)
  })
})
