import { describe, expect, it } from 'vitest'
import { highlightCode, highlightLines, languageOf } from '../src/file-highlight.ts'

describe('file highlighting', () => {
  it('highlights Java sources', () => {
    const lines = highlightLines('package demo;\n\npublic class Main {\n  private int value;\n}', 'Main.java')
    expect(lines).not.toBeNull()
    const html = lines!.join('\n')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('hljs-type')
  })

  it('highlights Python sources', () => {
    const lines = highlightLines('def hello(name):\n    return f"hi {name}"', 'hello.py')
    expect(lines).not.toBeNull()
    expect(lines!.join('\n')).toContain('hljs-keyword')
  })

  it('highlights fenced java blocks', () => {
    const html = highlightCode('public class A {}', 'java')
    expect(html).toContain('hljs-keyword')
    expect(highlightCode('x', 'unknown-lang')).toBeUndefined()
  })

  it('maps extensions to languages', () => {
    expect(languageOf('Main.java')).toBe('java')
    expect(languageOf('main.py')).toBe('python')
    expect(languageOf('notes.unknown')).toBeUndefined()
  })
})
