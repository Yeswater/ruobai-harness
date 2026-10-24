import type { CommandPrefix } from './api.ts'

export interface Trigger {
  kind: 'slash' | 'mention'
  /** Index of the trigger character. */
  start: number
  query: string
}

const BASE_TRIGGERS = ['/', '／']
const PREFIX_ALIASES: Record<CommandPrefix, string[]> = {
  '～': ['~', '～'],
  '！': ['！'],
  '#': ['#', '＃'],
}

/**
 * Detect a slash or mention token ending at the caret. Tokens never cross
 * whitespace, so `user@host` and `a/b` do not open a menu. `/` and `／` always
 * trigger; the settings-selected prefix adds an IME-friendly alternative.
 */
export function detectTrigger(
  text: string,
  caret: number,
  commandPrefix: CommandPrefix = '～',
): Trigger | null {
  if (caret < 0 || caret > text.length) return null
  const before = text.slice(0, caret)
  let index = before.length
  while (index > 0 && !/\s/.test(before[index - 1]!)) index -= 1
  const token = before.slice(index)
  if (!token) return null
  const head = token[0]!
  const query = token.slice(1)
  if (BASE_TRIGGERS.includes(head) || PREFIX_ALIASES[commandPrefix].includes(head)) {
    // `~/code` and `/usr/bin` are paths, not commands.
    if (query.includes('/') || query.includes('\\')) return null
    return { kind: 'slash', start: index, query }
  }
  if (head === '@') return { kind: 'mention', start: index, query }
  return null
}

/** Replace the trigger token before the caret and return the next caret. */
export function applyCompletion(
  text: string,
  caret: number,
  trigger: Trigger,
  replacement: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, trigger.start) + replacement + text.slice(caret),
    caret: trigger.start + replacement.length,
  }
}
