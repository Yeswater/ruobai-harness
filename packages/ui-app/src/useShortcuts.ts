import { useSyncExternalStore } from 'react'
import { chordFor, formatChord, getKeymap, subscribeKeymap, type ShortcutId } from './shortcuts.ts'

/** The binding shown in tooltips and menus, kept in sync with the keymap. */
export function useShortcutLabel(id: ShortcutId) {
  const map = useSyncExternalStore(subscribeKeymap, getKeymap)
  return formatChord(chordFor(id, map))
}
