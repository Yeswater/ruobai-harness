import { describe, expect, it } from 'vitest'
import type { ToolBlock } from '@ruobai/chat-protocol'
import { addedLines, diffLines } from '../src/tool-diff.ts'
import { toolEdit } from '../src/tool-summary.ts'

function block(name: string, input: Record<string, unknown>, output = 'ok'): ToolBlock {
  return { type: 'tool', name, input: JSON.stringify(input), output }
}

describe('line diff', () => {
  it('keeps context and marks a replaced line', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc')
    expect(lines.map(line => line.kind)).toEqual(['context', 'del', 'add', 'context'])
    expect(lines[1]).toMatchObject({ oldLine: 2, text: 'b' })
    expect(lines[2]).toMatchObject({ newLine: 2, text: 'B' })
  })

  it('handles insertions and deletions at the edges', () => {
    expect(diffLines('a\nb', 'x\na\nb').map(line => line.kind)).toEqual(['add', 'context', 'context'])
    expect(diffLines('a\nb', 'a').map(line => line.kind)).toEqual(['context', 'del'])
    expect(diffLines('', 'only')).toEqual([{ kind: 'add', newLine: 1, text: 'only' }])
    expect(diffLines('only', '')).toEqual([{ kind: 'del', oldLine: 1, text: 'only' }])
  })

  it('treats a new file as additions with line numbers', () => {
    expect(addedLines('x\ny\n')).toEqual([
      { kind: 'add', newLine: 1, text: 'x' },
      { kind: 'add', newLine: 2, text: 'y' },
    ])
  })

  it('falls back to delete-then-add for very large inputs', () => {
    const oldText = Array.from({ length: 600 }, (_, index) => `old ${index}`).join('\n')
    const newText = Array.from({ length: 600 }, (_, index) => `new ${index}`).join('\n')
    const lines = diffLines(oldText, newText)
    expect(lines).toHaveLength(1_200)
    expect(lines[0]!.kind).toBe('del')
    expect(lines.at(-1)!.kind).toBe('add')
  })
})

describe('tool edit payload', () => {
  it('reads the content of a written file', () => {
    expect(toolEdit(block('write_file', { path: 'a.ts', content: 'hello' })))
      .toEqual({ path: 'a.ts', content: 'hello' })
  })

  it('reads both sides of an in-place edit', () => {
    expect(toolEdit(block('edit_file', { path: 'a.ts', oldText: 'old', newText: 'new' })))
      .toEqual({ path: 'a.ts', oldText: 'old', newText: 'new' })
  })

  it('ignores tools without a readable diff', () => {
    expect(toolEdit(block('bash', { command: 'ls' }))).toBeNull()
    expect(toolEdit(block('edit_file', { path: 'a.ts' }))).toBeNull()
  })
})
