export type DiffKind = 'context' | 'add' | 'del'

export interface DiffLine {
  kind: DiffKind
  oldLine?: number
  newLine?: number
  text: string
}

/** Guard the O(n·m) table for pathological inputs. */
const MAX_DIFF_LINES = 500

function splitLines(text: string) {
  if (!text) return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  // A trailing newline is not an extra blank line.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** Every line of a new file is an addition. */
export function addedLines(content: string): DiffLine[] {
  return splitLines(content).map((text, index) => ({
    kind: 'add',
    newLine: index + 1,
    text,
  }))
}

/**
 * Minimal line diff for an edit: unchanged lines are context, and the changed
 * block keeps its old/new line numbers. Very large inputs fall back to a
 * delete-then-add block instead of allocating a huge table.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const before = splitLines(oldText)
  const after = splitLines(newText)
  if (!before.length && !after.length) return []
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
    return [
      ...before.map((text, index) => ({ kind: 'del' as const, oldLine: index + 1, text })),
      ...after.map((text, index) => ({ kind: 'add' as const, newLine: index + 1, text })),
    ]
  }

  const rows = before.length
  const cols = after.length
  const table: Uint16Array[] = Array.from(
    { length: rows + 1 },
    () => new Uint16Array(cols + 1),
  )
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'context', oldLine: i + 1, newLine: j + 1, text: before[i]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: 'del', oldLine: i + 1, text: before[i]! })
      i += 1
    } else {
      lines.push({ kind: 'add', newLine: j + 1, text: after[j]! })
      j += 1
    }
  }
  while (i < rows) {
    lines.push({ kind: 'del', oldLine: i + 1, text: before[i]! })
    i += 1
  }
  while (j < cols) {
    lines.push({ kind: 'add', newLine: j + 1, text: after[j]! })
    j += 1
  }
  return lines
}
