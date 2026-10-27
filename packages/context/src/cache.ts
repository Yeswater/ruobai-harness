/**
 * Prefix fingerprints and cache-break attribution.
 *
 * Prompt caching is a byte-prefix match, so the only way to explain a miss is
 * to know which region changed and how much it invalidated. Fingerprints are
 * computed from exactly what the request renders; the comparison is local and
 * never depends on provider support.
 */

import { createHash } from 'node:crypto'
import type { Message, ToolSchema } from '@ruobai/llm'

export type CacheBreakReason =
  | 'mode'
  | 'compaction'
  | 'prune'
  | 'tools'
  | 'system'
  | 'memory'
  | 'messages'

/** One rendered system section, so a break can name what changed. */
export interface PrefixSection {
  id: string
  hash: string
  chars: number
}

export interface PrefixFingerprint {
  tools: string
  system: string
  /** Per-section hashes of the system prompt, in render order. */
  sections?: PrefixSection[]
  /** One hash per rendered message, in order. */
  messages: string[]
  /** Model-visible characters per message; prices an invalidation. */
  chars: number[]
  systemChars: number
  mode?: string
  summaryUpToSeq: number
  pruneUpToSeq: number
}

export interface PrefixDivergence {
  region: 'tools' | 'system' | 'messages'
  /** First differing message index, for `region: 'messages'`. */
  index?: number
  /** Section id that changed, when the system prompt broke on one. */
  section?: string
  reason: CacheBreakReason
  /** Characters that must be processed again from the divergence point. */
  invalidatedChars: number
}

export function hashText(text: string) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function messageChars(message: Message) {
  let chars = 0
  for (const part of message.content) {
    if (part.type === 'text') chars += part.text.length
    else if (part.type === 'tool-call') chars += part.name.length + part.arguments.length
    else if (part.type === 'tool-result') chars += part.content.length
    else if (part.type === 'file') chars += part.text.length
    else if (part.type === 'reasoning') chars += part.text.length
    else if (part.type === 'image') chars += 6_000
  }
  return chars
}

export function buildFingerprint(input: {
  tools?: ToolSchema[]
  system: string
  sections?: Array<{ id: string; text: string }>
  messages: Message[]
  mode?: string
  summaryUpToSeq: number
  pruneUpToSeq: number
}): PrefixFingerprint {
  return {
    tools: hashText(JSON.stringify(input.tools ?? [])),
    system: hashText(input.system),
    ...(input.sections
      ? {
        sections: input.sections.map(section => ({
          id: section.id,
          hash: hashText(section.text),
          chars: section.text.length,
        })),
      }
      : {}),
    messages: input.messages.map(message => hashText(JSON.stringify(message))),
    chars: input.messages.map(messageChars),
    systemChars: input.system.length,
    mode: input.mode,
    summaryUpToSeq: input.summaryUpToSeq,
    pruneUpToSeq: input.pruneUpToSeq,
  }
}

/** Stable routing identity for providers that bucket by prefix. */
export function cacheKeyOf(fingerprint: PrefixFingerprint) {
  return hashText(`${fingerprint.tools}|${fingerprint.system}`)
}

/**
 * First place the prefix broke. Appending to the tail is not a break: a
 * request whose previous messages all reappear unchanged still hits.
 */
export function diffPrefix(
  previous: PrefixFingerprint | undefined,
  next: PrefixFingerprint,
): PrefixDivergence | undefined {
  if (!previous) return undefined

  const mode = previous.mode !== next.mode
  const summary = previous.summaryUpToSeq !== next.summaryUpToSeq
  const prune = previous.pruneUpToSeq !== next.pruneUpToSeq
  const tools = previous.tools !== next.tools
  const system = previous.system !== next.system

  let index = -1
  const shared = Math.min(previous.messages.length, next.messages.length)
  for (let position = 0; position < shared; position += 1) {
    if (previous.messages[position] !== next.messages[position]) {
      index = position
      break
    }
  }
  if (index < 0 && next.messages.length < previous.messages.length) {
    index = next.messages.length
  }
  // Only rendered bytes can break a prefix. Mode and epoch counters explain a
  // break; on their own they do not cause one.
  if (!tools && !system && index < 0) return undefined

  // Attribute a system break to the section that actually moved, so the UI can
  // say "long-term memory refreshed" instead of "system changed".
  let section: string | undefined
  if (system && previous.sections && next.sections) {
    const before = new Map(previous.sections.map(item => [item.id, item.hash]))
    const after = new Map(next.sections.map(item => [item.id, item.hash]))
    section = next.sections.find(item => before.get(item.id) !== item.hash)?.id
      ?? previous.sections.find(item => !after.has(item.id))?.id
  }

  const reason: CacheBreakReason = mode
    ? 'mode'
    : summary
      ? 'compaction'
      : prune
        ? 'prune'
        : tools
          ? 'tools'
          : system
            ? section === 'memory' ? 'memory' : 'system'
            : 'messages'

  const messageChars = next.chars.reduce((total, chars) => total + chars, 0)
  if (tools) {
    return { region: 'tools', reason, invalidatedChars: next.systemChars + messageChars }
  }
  if (system) {
    return {
      region: 'system',
      reason,
      ...(section ? { section } : {}),
      invalidatedChars: next.systemChars + messageChars,
    }
  }
  return {
    region: 'messages',
    ...(index >= 0 ? { index } : {}),
    reason,
    invalidatedChars: next.chars.slice(Math.max(0, index)).reduce((total, chars) => total + chars, 0),
  }
}
