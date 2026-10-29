import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@ruobai/chat-protocol'
import { PlanCard } from '../src/components/PlanCard.tsx'
import { Transcript } from '../src/components/Transcript.tsx'
import type { PlanProposal } from '../src/api.ts'

const proposal: PlanProposal = {
  id: 'p1',
  sessionId: 's1',
  title: '登录页拆分',
  plan: '## 登录页拆分\n\n1. 抽出表单组件\n2. 接到路由\n',
  createdAt: 1,
}

/**
 * The card is the only surface the user can accept a plan from, so the plan
 * and both decisions must be in the markup even without any interaction.
 */
describe('plan card', () => {
  it('shows the plan and both decisions', () => {
    const html = renderToStaticMarkup(
      <PlanCard proposal={proposal} onAccept={() => {}} onRevise={() => {}} />,
    )
    expect(html).toContain('实施计划')
    expect(html).toContain('登录页拆分')
    expect(html).toContain('抽出表单组件')
    expect(html).toContain('开始执行')
    expect(html).toContain('继续修改')
  })
})

/** The same plan stays readable in the transcript after the card is gone. */
describe('plan row in the transcript', () => {
  it('renders the plan body for a submitted plan', () => {
    const session: ChatSession = {
      id: 's1',
      title: 't',
      model: 'mock-1',
      provider: 'mock',
      mode: 'plan',
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
              name: 'plan_submit',
              input: JSON.stringify({ title: '登录页拆分', plan: proposal.plan }),
              output: '',
              startedAt: 1_000,
            },
          ],
        },
      ],
    }
    const html = renderToStaticMarkup(<Transcript session={session} activity={null} />)
    // The row is the plan's title; the body is the plan itself.
    expect(html).toContain('process-row-label">登录页拆分')
    expect(html).toContain('抽出表单组件')
    expect(html).toContain('等待确认')
  })
})
