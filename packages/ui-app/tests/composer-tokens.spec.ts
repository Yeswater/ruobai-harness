import { describe, expect, it } from 'vitest'
import { tokenizeComposer } from '../src/composer-tokens.ts'

function kinds(input: string) {
  return tokenizeComposer(input).map(token => [token.kind, token.text])
}

describe('composer tokenizer', () => {
  it('marks mentions and commands at word boundaries', () => {
    expect(kinds('@App.tsx /plan ~cmd #note !run')).toEqual([
      ['mention', '@App.tsx'],
      ['text', ' '],
      ['command', '/plan'],
      ['text', ' '],
      ['command', '~cmd'],
      ['text', ' '],
      ['command', '#note'],
      ['text', ' '],
      ['command', '!run'],
    ])
  })

  it('ignores triggers inside words and paths', () => {
    expect(kinds('see@file 5/8 and/or')).toEqual([['text', 'see@file 5/8 and/or']])
  })

  it('leaves tilde and slash paths as text', () => {
    expect(kinds('~/code /usr/bin ～/x')).toEqual([['text', '~/code /usr/bin ～/x']])
  })

  it('keeps line breaks and full-width prefixes', () => {
    const tokens = tokenizeComposer('第一行\n／goal 你好')
    expect(tokens.map(token => [token.kind, token.text])).toEqual([
      ['text', '第一行\n'],
      ['command', '／goal'],
      ['text', ' 你好'],
    ])
  })

  it('covers positions for highlighting', () => {
    const tokens = tokenizeComposer('hi @a.ts')
    const mention = tokens.find(token => token.kind === 'mention')!
    expect(mention.start).toBe(3)
    expect(mention.end).toBe(8)
  })
})
