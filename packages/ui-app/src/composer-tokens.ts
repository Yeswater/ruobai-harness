export type ComposerTokenKind = 'text' | 'mention' | 'command'

export interface ComposerToken {
  kind: ComposerTokenKind
  text: string
  start: number
  end: number
}

/**
 * Splits a draft into plain text and highlightable tokens. A trigger only
 * counts at a word boundary: `@file` and `/plan`, but not `a@b` or `5/8`.
 */
export function tokenizeComposer(input: string): ComposerToken[] {
  const tokens: ComposerToken[] = []
  if (!input) return tokens
  const pattern = /(^|\s)([@/／~～#＃!！])([^\s]+)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input))) {
    const start = match.index + (match[1]?.length ?? 0)
    if (start > last) {
      tokens.push({ kind: 'text', text: input.slice(last, start), start: last, end: start })
    }
    const text = `${match[2]}${match[3]}`
    tokens.push({
      kind: match[2] === '@' ? 'mention' : 'command',
      text,
      start,
      end: start + text.length,
    })
    last = start + text.length
  }
  if (last < input.length) {
    tokens.push({ kind: 'text', text: input.slice(last), start: last, end: input.length })
  }
  return tokens
}
