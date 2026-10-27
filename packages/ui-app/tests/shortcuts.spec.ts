import { describe, expect, it } from 'vitest'
import {
  isNewSessionShortcut, isPaletteShortcut, isSettingsShortcut, isMacPlatform, modKeyLabel, shortcutLabel,
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
