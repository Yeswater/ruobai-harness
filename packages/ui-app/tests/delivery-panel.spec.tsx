import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeliveryPanel } from '../src/components/DeliveryPanel.tsx'
import type { DeliverySnapshot } from '../src/api.ts'

function snapshot(overrides: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
  return {
    sessionId: 's1',
    rev: 10,
    contract: {
      id: 'k1',
      title: '交付 V1',
      customer: '客户 A',
      goals: ['上线'],
      nonGoals: ['不做多租户'],
      revision: 1,
      acceptance: [
        { id: 'A1', criterion: '首页首屏在 2 秒内渲染完成', kind: 'auto' },
        { id: 'A2', criterion: '客户能按 runbook 独立重启服务', kind: 'manual' },
      ],
    },
    verdict: 'fail',
    reason: null,
    checks: [
      { acceptanceId: 'A1', status: 'missing', reason: 'no evidence claimed', evidence: [] },
      { acceptanceId: 'A2', status: 'manual-pending', reason: 'needs a manual waiver', evidence: [] },
    ],
    waivers: [],
    blocked: true,
    ...overrides,
  }
}

describe('delivery panel', () => {
  it('renders nothing before the first snapshot arrives', () => {
    expect(renderToStaticMarkup(<DeliveryPanel delivery={null} />)).toBe('')
  })

  it('says the contract is missing instead of showing a verdict', () => {
    const html = renderToStaticMarkup(
      <DeliveryPanel delivery={snapshot({ contract: null, verdict: 'unsure', checks: [], blocked: false })} />,
    )
    expect(html).toContain('未开交付契约')
    expect(html).not.toContain('通过')
  })

  it('shows the blocking state, the gap count and every acceptance row', () => {
    const html = renderToStaticMarkup(<DeliveryPanel delivery={snapshot()} />)
    expect(html).toContain('未通过')
    expect(html).toContain('0/2')
    expect(html).toContain('交付 V1')
    expect(html).toContain('客户 A')
    expect(html).toContain('首页首屏在 2 秒内渲染完成')
    expect(html).toContain('客户能按 runbook 独立重启服务')
    expect(html).toContain('交付门禁会阻断回合')
  })

  it('shows the passing state without the blocking hint', () => {
    const html = renderToStaticMarkup(
      <DeliveryPanel
        delivery={snapshot({
          verdict: 'pass',
          blocked: false,
          waivers: ['A2'],
          checks: [
            { acceptanceId: 'A1', status: 'passed', reason: 'evidence traces to a successful tool call', evidence: ['bash exit 0'] },
            { acceptanceId: 'A2', status: 'passed', reason: 'waived by the user', evidence: [] },
          ],
        })}
      />,
    )
    expect(html).toContain('通过')
    expect(html).toContain('2/2')
    expect(html).toContain('已豁免：A2')
    expect(html).not.toContain('交付门禁会阻断回合')
  })

  it('explains why an unsure verdict was not judged', () => {
    const html = renderToStaticMarkup(
      <DeliveryPanel
        delivery={snapshot({
          verdict: 'unsure',
          reason: 'no-contract',
          blocked: false,
          checks: [],
        })}
      />,
    )
    expect(html).toContain('待确认')
    expect(html).toContain('no-contract')
  })
})
