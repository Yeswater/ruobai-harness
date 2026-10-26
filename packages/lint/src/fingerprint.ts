import { createHash } from 'node:crypto'

/** Strip ANSI, collapse whitespace: the same defect must hash the same way. */
export function normalizeMessage(message: string) {
  return (
    message
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** Workspace-relative POSIX path, so fingerprints survive checkout location. */
export function normalizePath(path: string, root: string) {
  const normalized = path.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const relative = normalized.startsWith(`${base}/`)
    ? normalized.slice(base.length + 1)
    : normalized
  return relative.replace(/^\.\//, '')
}

export function fingerprintOf(rule: string, path: string, message: string) {
  return createHash('sha256')
    .update(`${rule}|${path}|${normalizeMessage(message)}`)
    .digest('hex')
    .slice(0, 16)
}
