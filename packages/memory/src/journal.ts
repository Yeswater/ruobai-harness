import { createHash } from 'node:crypto'

export type MemoryScope = 'global' | 'project'

export type MemoryKind =
  | 'preference'
  | 'constraint'
  | 'decision'
  | 'fact'
  | 'gotcha'
  | 'procedure'

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference', 'constraint', 'decision', 'fact', 'gotcha', 'procedure',
]

export interface MemorySource {
  kind: 'user' | 'assistant' | 'tool' | 'file' | 'wiki'
  sessionId?: string
  seq?: number
  path?: string
  hash?: string
}

export interface MemoryItem {
  /** `mem_<hash8>`; derived from scope + normalized text so duplicates collide. */
  id: string
  scope: MemoryScope
  kind: MemoryKind
  /** One self-contained sentence, at most `MAX_ITEM_CHARS`. */
  text: string
  tags: string[]
  source: MemorySource
  confidence: number
  pinned?: boolean
  createdAt: number
  updatedAt: number
  validFrom: number
  /** Set when the item stops being true; history stays in the journal. */
  validTo?: number
  supersedes?: string[]
  hits: number
  lastUsedAt?: number
}

export type MemoryOp =
  | { op: 'add'; at: number; item: MemoryItem }
  | { op: 'supersede'; at: number; id: string; by?: string; reason?: string }
  | { op: 'forget'; at: number; id: string; reason?: string }
  | { op: 'touch'; at: number; ids: string[] }

export const MAX_ITEM_CHARS = 240

/** Whitespace-collapsed, trailing-punctuation-free form used for identity. */
export function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim().replace(/[。．.!！?？]+$/u, '')
}

export function memoryId(scope: MemoryScope, text: string) {
  const digest = createHash('sha256').update(`${scope}\0${normalizeText(text)}`).digest('hex')
  return `mem_${digest.slice(0, 8)}`
}

/**
 * Fold the append-only journal into current state. Every item is kept,
 * including invalidated ones: `validTo` closes validity without losing the
 * audit trail, and dormant items remain searchable.
 */
export function foldJournal(ops: MemoryOp[]): Map<string, MemoryItem> {
  const items = new Map<string, MemoryItem>()
  const supersededBy = new Map<string, string>()
  for (const op of ops) {
    if (op.op === 'add') {
      const item = { ...op.item, tags: [...op.item.tags], supersedes: op.item.supersedes ? [...op.item.supersedes] : undefined }
      items.set(item.id, item)
      continue
    }
    if (op.op === 'supersede' || op.op === 'forget') {
      const item = items.get(op.id)
      if (!item) continue
      item.validTo = op.at
      item.updatedAt = op.at
      if (op.op === 'supersede' && op.by) supersededBy.set(op.id, op.by)
      continue
    }
    for (const id of op.ids) {
      const item = items.get(id)
      if (!item) continue
      item.hits += 1
      item.lastUsedAt = op.at
    }
  }
  for (const [oldId, newId] of supersededBy) {
    const next = items.get(newId)
    if (!next) continue
    next.supersedes = [...new Set([...(next.supersedes ?? []), oldId])]
  }
  return items
}

export function isActive(item: MemoryItem, now = Date.now()) {
  return item.validTo === undefined || item.validTo > now
}

/** Reject text that would turn reference data into an instruction or a leak. */
export function screenText(text: string): string | undefined {
  if (!text.trim()) return 'empty memory text'
  if (text.length > MAX_ITEM_CHARS) return `memory text exceeds ${MAX_ITEM_CHARS} characters`
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return 'memory text contains control characters'
  if (/ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i.test(text)) {
    return 'memory text looks like an instruction overrides'
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return 'memory text contains a private key'
  if (/\b(sk|rk)-[A-Za-z0-9_-]{16,}\b/.test(text)) return 'memory text looks like a secret token'
  return undefined
}
