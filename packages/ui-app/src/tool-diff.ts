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

  // Trim shared edges first: a small edit in a large file must stay a small
  // diff instead of tripping the table guard and printing both files whole.
  const limit = Math.min(before.length, after.length)
  let pre = 0
  while (pre < limit && before[pre] === after[pre]) pre += 1
  let suf = 0
  const suffixLimit = Math.min(before.length, after.length) - pre
  while (suf < suffixLimit && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf += 1

  const beforeMid = before.slice(pre, before.length - suf)
  const afterMid = after.slice(pre, after.length - suf)
  if (!beforeMid.length && !afterMid.length) return []

  const context = 3
  const lines: DiffLine[] = []
  for (let index = Math.max(0, pre - context); index < pre; index += 1) {
    lines.push({ kind: 'context', oldLine: index + 1, newLine: index + 1, text: before[index]! })
  }

  if (beforeMid.length > MAX_DIFF_LINES || afterMid.length > MAX_DIFF_LINES) {
    beforeMid.forEach((text, index) => {
      lines.push({ kind: 'del', oldLine: pre + index + 1, text })
    })
    afterMid.forEach((text, index) => {
      lines.push({ kind: 'add', newLine: pre + index + 1, text })
    })
  } else {
    const rows = beforeMid.length
    const cols = afterMid.length
    const table: Uint16Array[] = Array.from(
      { length: rows + 1 },
      () => new Uint16Array(cols + 1),
    )
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = cols - 1; j >= 0; j -= 1) {
        table[i]![j] = beforeMid[i] === afterMid[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      }
    }

    let i = 0
    let j = 0
    while (i < rows && j < cols) {
      if (beforeMid[i] === afterMid[j]) {
        lines.push({ kind: 'context', oldLine: pre + i + 1, newLine: pre + j + 1, text: beforeMid[i]! })
        i += 1
        j += 1
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        lines.push({ kind: 'del', oldLine: pre + i + 1, text: beforeMid[i]! })
        i += 1
      } else {
        lines.push({ kind: 'add', newLine: pre + j + 1, text: afterMid[j]! })
        j += 1
      }
    }
    while (i < rows) {
      lines.push({ kind: 'del', oldLine: pre + i + 1, text: beforeMid[i]! })
      i += 1
    }
    while (j < cols) {
      lines.push({ kind: 'add', newLine: pre + j + 1, text: afterMid[j]! })
      j += 1
    }
  }

  const tailStart = before.length - suf
  for (let index = tailStart; index < Math.min(before.length, tailStart + context); index += 1) {
    lines.push({
      kind: 'context',
      oldLine: index + 1,
      newLine: after.length - suf + (index - tailStart) + 1,
      text: before[index]!,
    })
  }
  return lines
}
