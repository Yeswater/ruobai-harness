import { afterEach, describe, expect, it } from 'vitest'
import {
  SHORTCUTS, chordFor, chordOf, findConflict, formatChord, getKeymap, isNewSessionShortcut,
  isPaletteShortcut, isSettingsShortcut, isMacPlatform, matchesShortcut, modKeyLabel, resetKeymap,
  setKeymap, shortcutLabel,
} from '../src/shortcuts.ts'

describe('shortcuts', () => {
  it('recognises cmd+k and ctrl+k but not modified chords', () => {
    expect(isPaletteShortcut({ key: 'k', metaKey: true })).toBe(true)
    expect(isPaletteShortcut({ key: 'K', ctrlKey: true })).toBe(true)
    expect(isPaletteShortcut({ key: 'k', metaKey: true, shiftKey: true })).toBe(false)
    expect(isPaletteShortcut({ key: 'k', metaKey: true, altKey: true })).toBe(false)
    expect(isPaletteShortcut({ key: 'k' })).toBe(false)
    expect(isPaletteShortcut({ key: 'n', metaKey: true })).toBe(false)
  })

  it('recognises cmd+, and ctrl+, for settings', () => {
    expect(isSettingsShortcut({ key: ',', metaKey: true })).toBe(true)
    expect(isSettingsShortcut({ key: ',', ctrlKey: true })).toBe(true)
    // Some layouts report a different character but the same physical key.
    expect(isSettingsShortcut({ key: '＜', code: 'Comma', metaKey: true })).toBe(true)
    // Windows IMEs may keep Shift in the chord or report a full-width comma.
    expect(isSettingsShortcut({ key: '<', code: 'Comma', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(isSettingsShortcut({ key: '，', ctrlKey: true })).toBe(true)
    expect(isSettingsShortcut({ key: ',', code: 'NumpadComma', ctrlKey: true })).toBe(true)
    expect(isSettingsShortcut({ key: ',', metaKey: true, altKey: true })).toBe(false)
    expect(isSettingsShortcut({ key: ',' })).toBe(false)
    expect(isSettingsShortcut({ key: '.', code: 'Period', metaKey: true })).toBe(false)
    expect(isPaletteShortcut({ key: ',', metaKey: true })).toBe(false)
  })

  it('recognises cmd+n for a new session', () => {
    expect(isNewSessionShortcut({ key: 'n', metaKey: true })).toBe(true)
    expect(isNewSessionShortcut({ key: 'N', ctrlKey: true })).toBe(true)
    expect(isNewSessionShortcut({ key: 'n', metaKey: true, shiftKey: true })).toBe(false)
    expect(isNewSessionShortcut({ key: 'm', metaKey: true })).toBe(false)
  })

  it('labels shortcuts per platform', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('Win32')).toBe(false)
    expect(shortcutLabel('k', 'MacIntel')).toBe('⌘K')
    expect(shortcutLabel('k', 'Win32')).toBe('Ctrl+K')
    expect(shortcutLabel(',', 'MacIntel')).toBe('⌘,')
    expect(modKeyLabel('MacIntel')).toBe('⌘')
    expect(modKeyLabel('Linux x86_64')).toBe('Ctrl+')
  })
})

describe('keymap', () => {
  afterEach(() => resetKeymap())

  it('ships a unique default chord per command', () => {
    const seen = new Set(SHORTCUTS.map(item => `${item.default.key}|${item.default.shift}|${item.default.alt}`))
    expect(seen.size).toBe(SHORTCUTS.length)
  })

  it('reads a chord off an event', () => {
    expect(chordOf({ key: 'K', metaKey: true })).toEqual({ key: 'k', shift: false, alt: false })
    expect(chordOf({ key: 'K', ctrlKey: true, shiftKey: true })).toEqual({ key: 'k', shift: true, alt: false })
    expect(chordOf({ key: 'k' })).toBeUndefined()
    expect(chordOf({ key: 'Shift', metaKey: true })).toBeUndefined()
    // Full-width comma from a CJK IME still means the physical comma.
    expect(chordOf({ key: '，', ctrlKey: true })).toEqual({ key: ',', shift: false, alt: false })
  })

  it('prefers the user binding over the default', () => {
    setKeymap({ palette: { key: 'p', shift: true, alt: false } })
    expect(matchesShortcut({ key: 'p', metaKey: true, shiftKey: true }, 'palette')).toBe(true)
    expect(matchesShortcut({ key: 'k', metaKey: true }, 'palette')).toBe(false)
    expect(formatChord(chordFor('palette', getKeymap()), 'MacIntel')).toBe('⌘⇧P')
    expect(formatChord(chordFor('palette', getKeymap()), 'Win32')).toBe('Ctrl+Shift+P')
  })

  it('reports which command already owns a chord', () => {
    expect(findConflict('palette', { key: 'n', shift: false, alt: false }, {})?.id).toBe('new-session')
    expect(findConflict('sidebar', { key: 'z', shift: false, alt: false }, {})).toBeUndefined()
  })
})
