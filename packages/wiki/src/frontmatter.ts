import { createHash } from 'node:crypto'
import yaml from 'js-yaml'

export type PageStatus = 'draft' | 'processing' | 'ready' | 'stale'

export interface PageSource {
  kind: 'file' | 'session' | 'url'
  path?: string
  hash?: string
  session?: string
  seq?: number[]
}

export interface PageMeta {
  id: string
  title: string
  tags: string[]
  scope?: string
  sources: PageSource[]
  updated?: string
  confidence?: 'high' | 'medium' | 'low'
  status: PageStatus
  revision: number
}

export interface PageDocument {
  meta: PageMeta
  body: string
}

export const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Splits `---` frontmatter from a page body without trusting its YAML. */
export function parsePage(raw: string): PageDocument | undefined {
  const text = raw.replace(/^﻿/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return undefined
  let data: unknown
  try {
    data = yaml.load(match[1]!)
  } catch {
    return undefined
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const front = data as Record<string, unknown>
  const id = typeof front.id === 'string' ? front.id.trim() : ''
  if (!PAGE_ID.test(id)) return undefined
  const title = typeof front.title === 'string' && front.title.trim()
    ? front.title.trim()
    : id
  const tags = Array.isArray(front.tags)
    ? front.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const sources = Array.isArray(front.sources)
    ? front.sources.filter(isSource)
    : []
  const status = front.status === 'draft' || front.status === 'processing' || front.status === 'stale'
    ? front.status
    : 'ready'
  const confidence = front.confidence === 'high' || front.confidence === 'low'
    ? front.confidence
    : 'medium'
  return {
    meta: {
      id,
      title,
      tags,
      ...(typeof front.scope === 'string' ? { scope: front.scope } : {}),
      sources,
      ...(typeof front.updated === 'string' ? { updated: front.updated } : {}),
      confidence,
      status,
      revision: typeof front.revision === 'number' ? front.revision : 1,
    },
    body: (match[2] ?? '').trim(),
  }
}

export function serializePage(doc: PageDocument): string {
  const meta = {
    id: doc.meta.id,
    title: doc.meta.title,
    tags: doc.meta.tags,
    ...(doc.meta.scope ? { scope: doc.meta.scope } : {}),
    sources: doc.meta.sources,
    ...(doc.meta.updated ? { updated: doc.meta.updated } : {}),
    confidence: doc.meta.confidence ?? 'medium',
    status: doc.meta.status,
    revision: doc.meta.revision,
  }
  const front = yaml.dump(meta, { lineWidth: 120, noRefs: true }).trimEnd()
  return `---\n${front}\n---\n\n${doc.body.trim()}\n`
}

export function isSource(value: unknown): value is PageSource {
  if (!value || typeof value !== 'object') return false
  const source = value as Record<string, unknown>
  return source.kind === 'file' || source.kind === 'session' || source.kind === 'url'
}

/** `## 摘要` when present, else the first paragraph. */
export function summaryOf(body: string, maxChars = 300): string {
  const section = /^##\s*摘要\s*$([\s\S]*?)(?=^##\s|\Z)/m.exec(body)
  const source = section
    ? section[1]!
    : body.split(/\n\s*\n/).find(block => block.trim() && !block.trim().startsWith('#')) ?? ''
  const text = source.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/** Heading tree with each section's first sentence, for the L1 overview. */
export function overviewOf(body: string, maxChars = 4_000): string {
  const lines: string[] = []
  let heading = ''
  let first = ''
  const flush = () => {
    if (!heading) return
    lines.push(`- ${heading}${first ? `: ${first}` : ''}`)
  }
  for (const line of body.split('\n')) {
    const match = /^(#{2,6})\s+(.+?)\s*$/.exec(line)
    if (match) {
      flush()
      heading = match[2]!
      first = ''
      continue
    }
    if (!heading || first) continue
    const text = line.replace(/^[-*]\s+/, '').trim()
    if (!text) continue
    first = text.length > 120 ? `${text.slice(0, 119)}…` : text
  }
  flush()
  return lines.join('\n').slice(0, maxChars)
}

/** Alias-free content hash used for stale detection. */
export function hashContent(text: string) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
