/**
 * Line diff for approval previews.
 *
 * Uses an LCS table for normal files and falls back to a size summary when
 * the input is too large to diff cheaply.
 */
export function createDiff(before: string, after: string, path: string, maxLines = 400): string | undefined {
  const a = before.split('\n')
  const b = after.split('\n')

  if (a.length * b.length > 1_000_000) {
    return `--- a/${path}\n+++ b/${path}\n- (${a.length} lines)\n+ (${b.length} lines)\n`
  }

  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const ops: Array<{ type: ' ' | '-' | '+'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i]! })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: '-', text: a[i]! })
      i += 1
    } else {
      ops.push({ type: '+', text: b[j]! })
      j += 1
    }
  }
  while (i < n) ops.push({ type: '-', text: a[i++]! })
  while (j < m) ops.push({ type: '+', text: b[j++]! })

  if (!ops.some(op => op.type !== ' ')) return undefined

  const lines = [`--- a/${path}`, `+++ b/${path}`]
  for (const op of ops.slice(0, maxLines)) lines.push(`${op.type}${op.text}`)
  if (ops.length > maxLines) lines.push(`… ${ops.length - maxLines} more lines`)
  return lines.join('\n')
}
