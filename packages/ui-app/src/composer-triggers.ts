export interface Trigger {
  kind: 'slash' | 'mention'
  /** Index of the `/` or `@` character. */
  start: number
  query: string
}

/**
 * Detect a slash or mention token ending at the caret. Tokens never cross
 * whitespace, so `user@host` and `a/b` do not open a menu.
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  if (caret < 0 || caret > text.length) return null
  const before = text.slice(0, caret)
  let index = before.length
  while (index > 0 && !/\s/.test(before[index - 1]!)) index -= 1
  const token = before.slice(index)
  if (!token) return null
  if (token[0] === '/') return { kind: 'slash', start: index, query: token.slice(1) }
  if (token[0] === '@') return { kind: 'mention', start: index, query: token.slice(1) }
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
