/** Modifier + key recognition shared by the global shortcuts and the palette. */

export interface KeyLike {
  key: string
  code?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/** A global shortcut: always a Cmd/Ctrl chord, optionally with Shift/Alt. */
export interface Chord {
  key: string
  shift: boolean
  alt: boolean
}

export type ShortcutId =
  | 'palette'
  | 'settings'
  | 'new-session'
  | 'sidebar'
  | 'terminal'
  | 'expand-panel'

export interface ShortcutDef {
  id: ShortcutId
  label: string
  description: string
  default: Chord
}

const chord = (key: string, extra: Partial<Omit<Chord, 'key'>> = {}): Chord => ({
  key,
  shift: false,
  alt: false,
  ...extra,
})

/** Every global shortcut, in the order the settings page lists them. */
export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'palette',
    label: '全局搜索',
    description: '打开会话、设置与命令的搜索面板。',
    default: chord('k'),
  },
  {
    id: 'new-session',
    label: '新会话',
    description: '在最近的工作区里开一个未发送的会话。',
    default: chord('n'),
  },
  {
    id: 'settings',
    label: '打开设置',
    description: '打开设置对话框，停留在上次的页签。',
    default: chord(','),
  },
  {
    id: 'sidebar',
    label: '收起 / 展开侧栏',
    description: '隐藏或显示左侧的工作区栏。',
    default: chord('b'),
  },
  {
    id: 'terminal',
    label: '终端面板',
    description: '显示或隐藏右侧的终端。',
    default: chord('j'),
  },
  {
    id: 'expand-panel',
    label: '展开 / 收起面板',
    description: '放大或还原当前右侧面板。',
    default: chord('\\'),
  },
]

export function shortcutDef(id: ShortcutId) {
  return SHORTCUTS.find(item => item.id === id)!
}

/** Bindings the user changed; anything missing keeps its default. */
export type Keymap = Partial<Record<ShortcutId, Chord>>

const STORE_KEY = 'rbh-keymap'
const MODIFIER_KEYS = new Set(['shift', 'control', 'meta', 'alt', 'capslock', 'os'])

function readKeymap(): Keymap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const map: Keymap = {}
    for (const def of SHORTCUTS) {
      const value = parsed[def.id] as Partial<Chord> | undefined
      if (value && typeof value.key === 'string' && value.key) {
        map[def.id] = { key: value.key, shift: Boolean(value.shift), alt: Boolean(value.alt) }
      }
    }
    return map
  } catch {
    return {}
  }
}

let keymap: Keymap = readKeymap()
const listeners = new Set<() => void>()

export function getKeymap(): Keymap {
  return keymap
}

export function setKeymap(next: Keymap) {
  keymap = next
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORE_KEY, JSON.stringify(next))
  }
  for (const listener of listeners) listener()
}

export function resetKeymap() {
  setKeymap({})
}

export function subscribeKeymap(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The binding in force: the user's, or the default. */
export function chordFor(id: ShortcutId, map: Keymap = keymap): Chord {
  return map[id] ?? shortcutDef(id).default
}

export function isDefaultChord(id: ShortcutId, map: Keymap = keymap) {
  return map[id] === undefined
}

/** Another command already on this chord, if any. */
export function findConflict(id: ShortcutId, next: Chord, map: Keymap = keymap) {
  return SHORTCUTS.find(item => item.id !== id && chordEquals(chordFor(item.id, map), next))
}

export function chordEquals(a: Chord, b: Chord) {
  return a.key === b.key && a.shift === b.shift && a.alt === b.alt
}

/**
 * The chord a keyboard event stands for, or undefined when it is not a
 * Cmd/Ctrl chord worth binding (plain typing, modifier alone, function keys).
 */
export function chordOf(event: KeyLike): Chord | undefined {
  if (!(event.metaKey || event.ctrlKey)) return undefined
  const raw = event.key
  if (!raw || MODIFIER_KEYS.has(raw.toLowerCase())) return undefined
  // A comma arrives as the full-width character on CJK IMEs and with Shift on
  // some layouts; both mean the same binding.
  const key = raw === '，' ? ',' : raw.toLowerCase()
  const punctuation = key === ',' || key === '\\'
  return { key, shift: punctuation ? false : Boolean(event.shiftKey), alt: Boolean(event.altKey) }
}

export function matchesChord(event: KeyLike, expected: Chord) {
  const actual = chordOf(event)
  return Boolean(actual) && chordEquals(actual!, expected)
}

export function matchesShortcut(event: KeyLike, id: ShortcutId, map: Keymap = keymap) {
  return matchesChord(event, chordFor(id, map))
}

function detectPlatform(platform?: string) {
  if (platform !== undefined) return platform
  return typeof navigator === 'undefined' ? '' : navigator.platform
}

export function isMacPlatform(platform?: string) {
  return /mac|iphone|ipad/i.test(detectPlatform(platform))
}

function keyLabel(key: string) {
  return key.length === 1 ? key.toUpperCase() : key
}

/** `⌘⇧K` on macOS, `Ctrl+Shift+K` elsewhere. */
export function formatChord(chord: Chord, platform?: string) {
  const parts = [chord.alt ? (isMacPlatform(platform) ? '⌥' : 'Alt') : '', chord.shift ? (isMacPlatform(platform) ? '⇧' : 'Shift') : '']
  if (isMacPlatform(platform)) {
    return `⌘${parts.join('')}${keyLabel(chord.key)}`
  }
  return ['Ctrl', ...parts.filter(Boolean), keyLabel(chord.key)].join('+')
}

/** The binding for a command in the current keymap. */
export function shortcutLabelFor(id: ShortcutId, platform?: string) {
  return formatChord(chordFor(id), platform)
}

/** `⌘K` on macOS, `Ctrl+K` elsewhere. */
export function shortcutLabel(key: string, platform?: string) {
  return isMacPlatform(platform) ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`
}

/** `⌘` / `Ctrl+` — for hints that append the key themselves. */
export function modKeyLabel(platform?: string) {
  return isMacPlatform(platform) ? '⌘' : 'Ctrl+'
}

/* Default-binding predicates, kept for callers that do not use the keymap. */

/** ⌘K / Ctrl+K: the global search palette. */
export function isPaletteShortcut(event: KeyLike) {
  return matchesChord(event, shortcutDef('palette').default)
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
  return matchesChord(event, shortcutDef('new-session').default)
}

/** ⌘B / Ctrl+B: collapse or reveal the workspace sidebar. */
export function isSidebarShortcut(event: KeyLike) {
  return matchesChord(event, shortcutDef('sidebar').default)
}

/** ⌘J / Ctrl+J: show or hide the terminal dock. */
export function isTerminalShortcut(event: KeyLike) {
  return matchesChord(event, shortcutDef('terminal').default)
}

/** ⌘\ / Ctrl+\: expand or collapse the active right-hand panel. */
export function isExpandShortcut(event: KeyLike) {
  return matchesChord(event, shortcutDef('expand-panel').default)
}
