import { describe, expect, it } from 'vitest'
import type { Message, ToolSchema } from '@ruobai/llm'
import { buildFingerprint, cacheKeyOf, diffPrefix } from '../src/cache.ts'

const TOOLS: ToolSchema[] = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }]
const OTHER_TOOLS: ToolSchema[] = [{ name: 'bash', description: 'Shell', parameters: { type: 'object' } }]

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })

function fingerprint(input: {
  tools?: ToolSchema[]
  system?: string
  messages?: Message[]
  mode?: string
  summaryUpToSeq?: number
  pruneUpToSeq?: number
} = {}) {
  return buildFingerprint({
    tools: input.tools ?? TOOLS,
    system: input.system ?? 'you are a harness',
    messages: input.messages ?? [user('hello')],
    mode: input.mode ?? 'agent',
    summaryUpToSeq: input.summaryUpToSeq ?? -1,
    pruneUpToSeq: input.pruneUpToSeq ?? -1,
  })
}

describe('prefix fingerprints', () => {
  it('has no break before the first request', () => {
    expect(diffPrefix(undefined, fingerprint())).toBeUndefined()
  })

  it('treats an appended turn as a hit', () => {
    const previous = fingerprint({ messages: [user('one')] })
    const next = fingerprint({ messages: [user('one'), assistant('two'), user('three')] })
    expect(diffPrefix(previous, next)).toBeUndefined()
  })

  it('attributes a tool-set change to tools', () => {
    const breakage = diffPrefix(fingerprint(), fingerprint({ tools: OTHER_TOOLS }))
    expect(breakage).toMatchObject({ region: 'tools', reason: 'tools' })
  })

  it('attributes a mode switch that reshapes the tools to the mode', () => {
    const breakage = diffPrefix(fingerprint(), fingerprint({ mode: 'plan', tools: OTHER_TOOLS }))
    expect(breakage).toMatchObject({ region: 'tools', reason: 'mode' })
  })

  it('attributes a system-prompt rewrite to system and prices the tail', () => {
    const previous = fingerprint({ messages: [user('a'), assistant('b')] })
    const next = fingerprint({ system: 'you are a different harness', messages: [user('a'), assistant('b')] })
    const breakage = diffPrefix(previous, next)!
    expect(breakage.region).toBe('system')
    expect(breakage.reason).toBe('system')
    expect(breakage.invalidatedChars).toBe(next.systemChars + next.chars.reduce((total, chars) => total + chars, 0))
  })

  it('reports the first rewritten message and its suffix', () => {
    const previous = fingerprint({ messages: [user('a'), user('b'), user('c')] })
    const next = fingerprint({ messages: [user('a'), user('B'), user('c')] })
    const breakage = diffPrefix(previous, next)!
    expect(breakage).toMatchObject({ region: 'messages', index: 1, reason: 'messages' })
    expect(breakage.invalidatedChars).toBe(next.chars[1]! + next.chars[2]!)
  })

  it('explains a summary rewrite as compaction', () => {
    const previous = fingerprint({ messages: [user('a')] })
    const next = fingerprint({
      system: 'you are a harness\n\nSummary of the earlier conversation',
      messages: [user('b')],
      summaryUpToSeq: 3,
    })
    expect(diffPrefix(previous, next)).toMatchObject({ region: 'system', reason: 'compaction' })
  })

  it('explains a rewritten tool result as pruning', () => {
    const previous = fingerprint({ messages: [user('a'), assistant('b')] })
    const next = fingerprint({ messages: [user('a'), assistant('B')], pruneUpToSeq: 1 })
    expect(diffPrefix(previous, next)).toMatchObject({ region: 'messages', reason: 'prune' })
  })

  it('keys the routing identity on tools and system only', () => {
    const one = fingerprint({ messages: [user('a')] })
    const two = fingerprint({ messages: [user('b')], mode: 'plan' })
    expect(cacheKeyOf(one)).toBe(cacheKeyOf(two))
    expect(cacheKeyOf(one)).not.toBe(cacheKeyOf(fingerprint({ tools: OTHER_TOOLS })))
  })
})
