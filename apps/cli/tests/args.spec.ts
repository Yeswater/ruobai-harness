import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.ts'

describe('cli arguments', () => {
  it('defaults to cordis.yml and the configured port', () => {
    expect(parseArgs([])).toEqual({ configPath: 'cordis.yml', help: false })
  })

  it('accepts a positional config path mixed with flags', () => {
    expect(parseArgs(['cordis.local.yml', '--port', '4400'])).toEqual({
      configPath: 'cordis.local.yml',
      port: 4400,
      help: false,
    })
    expect(parseArgs(['--port=4400', 'cordis.local.yml'])).toEqual({
      configPath: 'cordis.local.yml',
      port: 4400,
      help: false,
    })
  })

  it('reads --port with a space, an equals sign, or after --', () => {
    expect(parseArgs(['--port', '4400']).port).toBe(4400)
    expect(parseArgs(['--port=4400']).port).toBe(4400)
    expect(parseArgs(['--', '--port', '0']).port).toBe(0)
  })

  it('reads --workspace with a space, -C, or an equals sign', () => {
    expect(parseArgs(['--workspace', '/tmp/project']).workspace).toBe('/tmp/project')
    expect(parseArgs(['-C', '/tmp/project', '--port', '0']).workspace).toBe('/tmp/project')
    expect(parseArgs(['--workspace=/tmp/project']).workspace).toBe('/tmp/project')
    expect(() => parseArgs(['--workspace'])).toThrow('needs a directory')
  })

  it('recognises --help', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('rejects missing, malformed and out-of-range ports', () => {
    expect(() => parseArgs(['--port'])).toThrow('--port needs a value')
    expect(() => parseArgs(['--port', 'abc'])).toThrow('invalid port')
    expect(() => parseArgs(['--port', '-1'])).toThrow('invalid port')
    expect(() => parseArgs(['--port=65536'])).toThrow('invalid port')
    expect(() => parseArgs(['--port', '1.5'])).toThrow('invalid port')
  })

  it('rejects unknown options and extra positional arguments', () => {
    expect(() => parseArgs(['--host', '0.0.0.0'])).toThrow('unknown option')
    expect(() => parseArgs(['a.yml', 'b.yml'])).toThrow('unexpected argument')
  })
})
