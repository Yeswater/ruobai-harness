import { describe, expect, it } from 'vitest'
import { applyCompletion, detectTrigger } from '../src/composer-triggers.ts'

describe('composer triggers', () => {
  it('detects a slash command at the start of a token', () => {
    expect(detectTrigger('/', 1)).toEqual({ kind: 'slash', start: 0, query: '' })
    expect(detectTrigger('hello /pla', 10)).toEqual({ kind: 'slash', start: 6, query: 'pla' })
    expect(detectTrigger('line\n/plan', 10)).toEqual({ kind: 'slash', start: 5, query: 'plan' })
  })

  it('accepts tilde and fullwidth variants for slash commands', () => {
    expect(detectTrigger('~pla', 4)).toEqual({ kind: 'slash', start: 0, query: 'pla' })
    expect(detectTrigger('～pla', 4)).toEqual({ kind: 'slash', start: 0, query: 'pla' })
    expect(detectTrigger('／plan', 5)).toEqual({ kind: 'slash', start: 0, query: 'plan' })
    // Home-directory paths are not commands.
    expect(detectTrigger('~/code', 6)).toBeNull()
    expect(detectTrigger('/usr/bin', 8)).toBeNull()
  })

  it('honours the configured command prefix', () => {
    expect(detectTrigger('！pla', 4, '！')).toEqual({ kind: 'slash', start: 0, query: 'pla' })
    expect(detectTrigger('#plan', 5, '#')).toEqual({ kind: 'slash', start: 0, query: 'plan' })
    expect(detectTrigger('～pla', 4, '#')).toBeNull()
    expect(detectTrigger('!plan', 5, '！')).toBeNull()
  })

  it('detects mentions after whitespace', () => {
    expect(detectTrigger('hi @src', 7)).toEqual({ kind: 'mention', start: 3, query: 'src' })
    expect(detectTrigger('@', 1)).toEqual({ kind: 'mention', start: 0, query: '' })
  })

  it('ignores slashes and at signs inside words', () => {
    expect(detectTrigger('a/b', 3)).toBeNull()
    expect(detectTrigger('user@host', 9)).toBeNull()
  })

  it('replaces the token before the caret', () => {
    const trigger = detectTrigger('hello /pla', 10)!
    expect(applyCompletion('hello /pla', 10, trigger, '')).toEqual({ text: 'hello ', caret: 6 })
    const mention = detectTrigger('see @src/app', 12)!
    expect(applyCompletion('see @src/app', 12, mention, '@src/app.ts '))
      .toEqual({ text: 'see @src/app.ts ', caret: 16 })
  })
})
