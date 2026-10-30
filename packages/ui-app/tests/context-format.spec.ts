import { describe, expect, it } from 'vitest'
import { formatTokens } from '../src/components/ContextCard.tsx'

describe('context window formatting', () => {
  it('uses decimal units so vendor-published windows read back exactly', () => {
    // A 1M model must read as 1M, not 977k from binary factors.
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(400_000)).toBe('400k')
    expect(formatTokens(256_000)).toBe('256k')
    expect(formatTokens(262_144)).toBe('262.1k')
    expect(formatTokens(1_536)).toBe('1.5k')
  })
})
