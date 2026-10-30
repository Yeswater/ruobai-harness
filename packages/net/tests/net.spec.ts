import { describe, expect, it } from 'vitest'
import { buildProxyEnv, normalizeProxyUrl } from '../src/index.ts'

describe('normalizeProxyUrl', () => {
  it('accepts a bare host:port', () => {
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('keeps an explicit http scheme and drops a trailing slash', () => {
    expect(normalizeProxyUrl('http://proxy.local:8080/')).toBe('http://proxy.local:8080')
  })

  it('keeps https proxies', () => {
    expect(normalizeProxyUrl('https://proxy.local:8443')).toBe('https://proxy.local:8443')
  })

  it('rejects socks and non-http schemes', () => {
    expect(() => normalizeProxyUrl('socks5://127.0.0.1:7890')).toThrow(/HTTP/)
    expect(() => normalizeProxyUrl('file:///tmp/socket')).toThrow(/HTTP/)
  })

  it('returns undefined for an empty value', () => {
    expect(normalizeProxyUrl('')).toBeUndefined()
    expect(normalizeProxyUrl('   ')).toBeUndefined()
  })

  it('rejects malformed input', () => {
    expect(() => normalizeProxyUrl('http://')).toThrow()
  })
})

describe('buildProxyEnv', () => {
  it('sets both cases and normalizes NO_PROXY suffixes', () => {
    const env = buildProxyEnv({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890' })
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.NO_PROXY).toContain('.local')
    expect(env.NO_PROXY).not.toContain('*.')
  })

  it('only exports variables that have a value', () => {
    const env = buildProxyEnv({ http: 'http://127.0.0.1:7890' })
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.ALL_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('uses an explicit NO_PROXY override', () => {
    const env = buildProxyEnv({ http: 'http://p:1', noProxy: 'example.com, *.corp.example' })
    expect(env.NO_PROXY).toBe('example.com,.corp.example')
  })
})
