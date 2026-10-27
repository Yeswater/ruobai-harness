import { describe, expect, it } from 'vitest'
import { markdownHeadingId } from '../src/components/MarkdownPreview.tsx'

describe('markdownHeadingId', () => {
  it('keeps CJK text and turns spaces into dashes', () => {
    expect(markdownHeadingId('为什么 要重构')).toBe('为什么-要重构')
  })

  it('drops markdown emphasis and punctuation', () => {
    expect(markdownHeadingId('**布局**：三栏')).toBe('布局三栏')
  })

  it('is stable for the same heading', () => {
    expect(markdownHeadingId('Step 1 / 落地')).toBe(markdownHeadingId('Step 1 / 落地'))
  })
})
