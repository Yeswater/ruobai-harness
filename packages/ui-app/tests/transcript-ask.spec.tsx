import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import { Transcript } from '../src/components/Transcript.tsx'

/**
 * A question waiting for the human, rendered where it was asked.
 *
 * It must not be folded into the process group: the question is the next thing
 * the user acts on. The tests render the real component because the row's
 * wording and its placement were both reported bugs.
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
    expect(html).toContain('向你提问')
    expect(html).not.toContain('无输出')
  })

  it('keeps a waiting question out of the process group', () => {
    const html = renderToStaticMarkup(<Transcript session={sessionWithAsk('')} activity={null} />)
    // The question is its own card, not a row inside a collapsible run.
    expect(html).toContain('approval ask ask-inline')
    expect(html).not.toContain('process-body')
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
    expect(html).toContain('等待回答')
    expect(html).toContain('<button type="button" class="btn ghost">复用本地</button>')
    expect(html).toContain('<button type="button" class="btn ghost">重装</button>')
  })

  it('keeps them as plain text once no request is waiting', () => {
    const html = renderToStaticMarkup(
      <Transcript session={sessionWithAsk('')} activity={null} asks={[]} />,
    )
    expect(html).not.toContain('<button type="button" class="btn ghost">复用本地</button>')
    expect(html).toContain('复用本地')
  })
})

describe('several questions', () => {
  const questions = [
    { question: '部署到哪台机器？', options: ['本机', 'VPS'], allowFreeText: true },
    { question: '用哪个端口？', options: ['4310', '4400'], allowFreeText: true },
    { question: '开鉴权吗？', options: ['开', '不开'], allowFreeText: true },
  ]
  const request = {
    id: 'r2',
    sessionId: 's1',
    question: questions[0]!.question,
    options: questions[0]!.options,
    allowFreeText: true,
    questions,
    createdAt: 1,
    expiresAt: 2,
  }

  function multiSession(): ChatSession {
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
            { type: 'tool', callId: 'c1', name: 'ask_user', input: JSON.stringify({ questions }), output: '', startedAt: 1_000 },
          ],
        },
      ],
    } as unknown as ChatSession
  }

  it('shows one question per page instead of stacking them', () => {
    const html = renderToStaticMarkup(
      <Transcript session={multiSession()} activity={null} asks={[request as never]} onAnswerAsk={() => undefined} />,
    )
    expect(html).toContain('1/3')
    expect(html).toContain('部署到哪台机器？')
    // The pages that come later are not on screen yet.
    expect(html).not.toContain('用哪个端口？')
    expect(html).not.toContain('开鉴权吗？')
    expect(html).toContain('下一页')
  })
})
