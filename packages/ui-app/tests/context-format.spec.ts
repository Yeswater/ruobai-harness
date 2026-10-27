import { describe, expect, it } from 'vitest'
import { formatTokens } from '../src/components/ContextCard.tsx'

describe('context window formatting', () => {
  it('uses the same 1024 factors as the settings input', () => {
    // The K/M selector stores 400K as 409_600 tokens; it must read back as 400k.
    expect(formatTokens(400 * 1024)).toBe('400k')
    expect(formatTokens(256 * 1024)).toBe('256k')
    expect(formatTokens(1024 * 1024)).toBe('1M')
    expect(formatTokens(1536)).toBe('1.5k')
  })
})
