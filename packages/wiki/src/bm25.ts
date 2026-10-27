export interface WeightedDocument {
  terms: Map<string, number>
  length: number
}

const WORD = /[a-z0-9][a-z0-9_-]*/g
const CJK = /[㐀-䶿一-鿿]+/g

/**
 * ASCII words (identifiers kept whole and also split on `_` / `-`) plus CJK
 * bigrams. No dictionary and no network: the same text always tokenizes the
 * same way.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const match of lower.matchAll(WORD)) {
    const word = match[0]!
    tokens.push(word)
    if (word.includes('_') || word.includes('-')) {
      for (const part of word.split(/[_-]+/)) if (part) tokens.push(part)
    }
  }
  for (const match of lower.matchAll(CJK)) {
    const chars = [...match[0]!]
    if (chars.length === 1) tokens.push(chars[0]!)
    for (let index = 1; index < chars.length; index += 1) {
      tokens.push(chars[index - 1]! + chars[index]!)
    }
  }
  return tokens
}

/** Weighted term frequencies: title 3×, tags 2×, heading 2×, body 1×. */
export function buildTerms(fields: Array<{ text: string; weight: number }>): WeightedDocument {
  const terms = new Map<string, number>()
  for (const field of fields) {
    if (!field.text) continue
    for (const token of tokenize(field.text)) {
      terms.set(token, (terms.get(token) ?? 0) + field.weight)
    }
  }
  let length = 0
  for (const weight of terms.values()) length += weight
  return { terms, length }
}

export interface RankedDocument {
  index: number
  score: number
}

/** BM25 over weighted term frequencies (Robertson & Zaragoza, k1=1.2, b=0.75). */
export class Bm25Index {
  private readonly postings = new Map<string, Map<number, number>>()
  private readonly lengths: number[] = []

  constructor(private readonly documents: WeightedDocument[], private readonly k1 = 1.2, private readonly b = 0.75) {
    documents.forEach((document, index) => {
      this.lengths.push(document.length || 1)
      for (const [term, weight] of document.terms) {
        let entry = this.postings.get(term)
        if (!entry) {
          entry = new Map()
          this.postings.set(term, entry)
        }
        entry.set(index, weight)
      }
    })
  }

  get size() {
    return this.documents.length
  }

  search(query: string, options: { limit?: number; deadline?: number } = {}): RankedDocument[] {
    const limit = Math.max(1, options.limit ?? 8)
    const terms = [...new Set(tokenize(query))]
    if (!terms.length) return []
    const total = this.documents.length
    const average = this.lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, total)
    const scores = new Map<number, number>()

    for (const term of terms) {
      const entry = this.postings.get(term)
      if (!entry) continue
      const df = entry.size
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      for (const [index, tf] of entry) {
        // A partial answer beats a stalled turn: stop when the deadline passes.
        if (options.deadline !== undefined && Date.now() > options.deadline) break
        const length = this.lengths[index]!
        const score = idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * length) / average))
        scores.set(index, (scores.get(index) ?? 0) + score)
      }
      if (options.deadline !== undefined && Date.now() > options.deadline) break
    }

    return [...scores.entries()]
      .map(([index, score]) => ({ index, score }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit)
  }
}
