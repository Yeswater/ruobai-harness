import type { SessionEvent } from '@ruobai/session'
import type { MemoryKind } from '@ruobai/memory'

export interface Candidate {
  text: string
  kind: MemoryKind
}

/**
 * Deterministic extraction. Only the user's own words can create a memory in
 * this mode: tool output is untrusted data and never becomes a candidate.
 */
const SIGNALS: Array<{ re: RegExp; kind: MemoryKind }> = [
  { re: /记住|请记下|记一下|remember\s+(?:that\s+)?/i, kind: 'fact' },
  { re: /以后(?:都|一律|统一)?|从现在开始|from now on|always\s+(?:use|run|prefer)/i, kind: 'decision' },
  { re: /不要再|别再|永远不要|never\s+(?:use|run|do)|don't\s+ever/i, kind: 'constraint' },
  { re: /我(?:更)?(?:喜欢|偏好)|i\s+prefer|prefer\s+/i, kind: 'preference' },
]

const MAX_CHARS = 240

export function extractRules(events: SessionEvent[]): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'message/user') continue
    if (event.data?.source?.kind) continue
    const text = String(event.data?.text ?? '')
    if (!text || text.trim().startsWith('/')) continue
    for (const raw of text.split(/\n+/)) {
      const line = raw.replace(/^[-*]\s+/, '').trim()
      if (!line || line.length > MAX_CHARS) continue
      const signal = SIGNALS.find(item => item.re.test(line))
      if (!signal) continue
      const key = line.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ text: line, kind: signal.kind })
    }
  }
  return out
}
