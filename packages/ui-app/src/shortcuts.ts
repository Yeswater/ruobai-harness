/** Modifier + key recognition shared by the global shortcuts and the palette. */

export interface KeyLike {
  key: string
  code?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/** ⌘ on macOS, Ctrl elsewhere — and no Alt/Shift, which build a different chord. */
function isPlainMod(event: KeyLike) {
  return Boolean((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey)
}

/** ⌘K / Ctrl+K: the global search palette. */
export function isPaletteShortcut(event: KeyLike) {
  return isPlainMod(event) && event.key.toLowerCase() === 'k'
}

/**
 * ⌘, / Ctrl+,: settings.
 *
 * The physical `code` wins over `key`: Windows reports the comma through an
 * IME as a full-width character or with Shift held on some layouts, and the
 * chord must still open settings there.
 */
export function isSettingsShortcut(event: KeyLike) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false
  if (event.code === 'Comma' || event.code === 'NumpadComma') return true
  return !event.shiftKey && (event.key === ',' || event.key === '，')
}

/** ⌘N / Ctrl+N: a new session. */
export function isNewSessionShortcut(event: KeyLike) {
  return isPlainMod(event) && event.key.toLowerCase() === 'n'
}

/** ⌘B / Ctrl+B: collapse or reveal the workspace sidebar. */
export function isSidebarShortcut(event: KeyLike) {
  return isPlainMod(event) && event.key.toLowerCase() === 'b'
}

/** ⌘\ / Ctrl+\: expand or collapse the active right-hand panel. */
export function isExpandShortcut(event: KeyLike) {
  return isPlainMod(event) && (event.key === '\\' || event.code === 'Backslash')
}

function detectPlatform(platform?: string) {
  if (platform !== undefined) return platform
  return typeof navigator === 'undefined' ? '' : navigator.platform
}

export function isMacPlatform(platform?: string) {
  return /mac|iphone|ipad/i.test(detectPlatform(platform))
}

/** `⌘K` on macOS, `Ctrl+K` elsewhere. */
export function shortcutLabel(key: string, platform?: string) {
  return isMacPlatform(platform) ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`
}

/** `⌘` / `Ctrl+` — for hints that append the key themselves. */
export function modKeyLabel(platform?: string) {
  return isMacPlatform(platform) ? '⌘' : 'Ctrl+'
}
