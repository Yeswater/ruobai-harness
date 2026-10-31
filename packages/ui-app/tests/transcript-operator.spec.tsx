import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import { Transcript } from '../src/components/Transcript.tsx'
import { ContextMenuProvider } from '../src/components/ContextMenu.tsx'

function render(text: string) {
  return renderToStaticMarkup(
    <ContextMenuProvider>
      <Transcript session={sessionWith(text)} activity={null} />
    </ContextMenuProvider>,
  )
}

function sessionWith(text: string): ChatSession {
  return {
    id: 's1',
    title: 't',
    model: 'mock-1',
    createdAt: 1,
    updatedAt: 2,
    streaming: false,
    messages: [{
      id: 'u1',
      role: 'user',
      status: 'done',
      createdAt: 1,
      blocks: [{ type: 'text', text }],
    }],
  }
}

describe('operator rendering in user messages', () => {
  it('marks @ references and command tokens', () => {
    const html = render('更新 @plugin-ecosystem-timeline.svg，然后 /plan 一下')
    expect(html).toContain('class="msg-token mention">@plugin-ecosystem-timeline.svg')
    expect(html).toContain('class="msg-token command">/plan')
    // The message text itself is unchanged.
    expect(html).toContain('更新 ')
  })

  it('leaves path-like prefixes as plain text', () => {
    const html = render('看 ~/code 和 /usr/bin')
    expect(html).not.toContain('msg-token')
    expect(html).toContain('看 ~/code 和 /usr/bin')
  })
})
