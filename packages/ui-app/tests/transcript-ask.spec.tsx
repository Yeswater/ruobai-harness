import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import { Transcript } from '../src/components/Transcript.tsx'

/**
 * A question the model put to the human, rendered as the process row it becomes.
 *
 * Rendering the real component is the point: the bug was in how the row chose
 * its body ("无输出"), and a helper-level assertion would not have caught it.
 * `streaming` keeps the process group open, which is the state the user reports
 * the bug in (a turn that is waiting for an answer).
 */
function sessionWithAsk(output: string): ChatSession {
  return {
    id: 's1',
    title: 't',
    model: 'mock-1',
    provider: 'mock',
    mode: 'agent',
    permission: 'full-access',
    workspace: '/tmp',
    createdAt: 1,
    updatedAt: 2,
    streaming: true,
    messages: [
      {
        id: 'a1',
        role: 'assistant',
        status: 'streaming',
        createdAt: 1,
        blocks: [
          {
            type: 'tool',
            callId: 'c1',
            name: 'ask_user',
            input: JSON.stringify({ question: '要用哪套部署？', options: ['复用本地', '重装'] }),
            output,
            startedAt: 1_000,
          },
        ],
      },
    ],
  } as unknown as ChatSession
}

describe('ask_user in the transcript', () => {
  it('shows the question and its options instead of "无输出"', () => {
    const html = renderToStaticMarkup(<Transcript session={sessionWithAsk('')} activity={null} />)
    expect(html).toContain('要用哪套部署？')
    expect(html).toContain('复用本地')
    expect(html).toContain('等待回答')
    expect(html).not.toContain('无输出')
  })

  it('shows the logged answer once one exists', () => {
    const html = renderToStaticMarkup(
      <Transcript session={sessionWithAsk('用户回答：复用本地')} activity={null} />,
    )
    expect(html).toContain('用户回答：复用本地')
    expect(html).not.toContain('等待回答')
  })
})

describe('answering from the step', () => {
  const request = {
    id: 'r1',
    sessionId: 's1',
    question: '要用哪套部署？',
    options: ['复用本地', '重装'],
    allowFreeText: true,
    createdAt: 1,
    expiresAt: 2,
  }

  it('turns the options into real choices while the question waits', () => {
    const html = renderToStaticMarkup(
      <Transcript
        session={sessionWithAsk('')}
        activity={null}
        asks={[request as never]}
        onAnswerAsk={() => undefined}
      />,
    )
    expect(html).toContain('<button type="button">复用本地</button>')
    expect(html).toContain('<button type="button">重装</button>')
  })

  it('keeps them as plain text once no request is waiting', () => {
    const html = renderToStaticMarkup(
      <Transcript session={sessionWithAsk('')} activity={null} asks={[]} />,
    )
    expect(html).not.toContain('<button type="button">复用本地</button>')
    expect(html).toContain('复用本地')
  })
})
