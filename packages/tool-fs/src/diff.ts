/**
 * Line diff for approval previews.
 *
 * Common prefix/suffix handling keeps a one-line edit in a large file small:
 * without it, an 11k-line stylesheet edit either blew the LCS guard or showed
 * only "N lines" and no hunk at all.
 */
export function createDiff(before: string, after: string, path: string, maxLines = 400): string | undefined {
  const a = before.split('\n')
  const b = after.split('\n')

  const limit = Math.min(a.length, b.length)
  let pre = 0
  while (pre < limit && a[pre] === b[pre]) pre += 1
  let suf = 0
  const suffixLimit = Math.min(a.length, b.length) - pre
  while (suf < suffixLimit && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1

  const aMid = a.slice(pre, a.length - suf)
  const bMid = b.slice(pre, b.length - suf)
  if (!aMid.length && !bMid.length) return undefined

  const header = [`--- a/${path}`, `+++ b/${path}`]
  if (aMid.length * bMid.length > 1_000_000) {
    return [
      ...header,
      `@@ -${pre + 1},${aMid.length} +${pre + 1},${bMid.length} @@`,
      `- (${aMid.length} lines changed)`,
      `+ (${bMid.length} lines changed)`,
    ].join('\n')
  }

  const mid = lcsOps(aMid, bMid)
  const contextBefore = a.slice(Math.max(0, pre - 3), pre)
  const contextAfter = a.slice(a.length - suf, a.length - suf + 3)
  const ops = [
    ...contextBefore.map(text => ({ type: ' ' as const, text })),
    ...mid,
    ...contextAfter.map(text => ({ type: ' ' as const, text })),
  ]

  const lines = [...header]
  for (const op of ops.slice(0, maxLines)) lines.push(`${op.type}${op.text}`)
  if (ops.length > maxLines) lines.push(`… ${ops.length - maxLines} more lines`)
  return lines.join('\n')
}

function lcsOps(a: string[], b: string[]): Array<{ type: ' ' | '-' | '+'; text: string }> {
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
  return ops
}
