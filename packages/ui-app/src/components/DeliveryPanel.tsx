import type { DeliverySnapshot } from '../api.ts'

/**
 * Contract + acceptance + verdict, for the right-hand panel.
 *
 * The verdict is computed by the host from the session log, so this component
 * never decides anything: it renders what the gate would do. A missing contract
 * says so instead of showing an empty "passed".
 */
export function DeliveryPanel({ delivery }: { delivery: DeliverySnapshot | null }) {
  if (!delivery) return null
  if (!delivery.contract) return <div className="session-empty">未开交付契约</div>

  const { contract, checks, verdict, blocked } = delivery
  const passed = checks.filter(check => check.status === 'passed').length
  const badge = verdict === 'pass' ? '通过' : verdict === 'unsure' ? '待确认' : '未通过'

  return (
    <div className="delivery-panel">
      <div className={`delivery-badge ${verdict}`}>
        <span className="delivery-dot" />
        <span className="delivery-badge-label">{badge}</span>
        <span className="delivery-badge-count">{passed}/{checks.length}</span>
      </div>

      <div className="delivery-title" title={contract.title}>
        {contract.title}
        <span className="delivery-rev">r{contract.revision}</span>
      </div>
      {contract.customer ? <div className="delivery-sub">{contract.customer}</div> : null}

      <ul className="delivery-checks">
        {checks.map((check) => {
          const item = contract.acceptance.find(candidate => candidate.id === check.acceptanceId)
          return (
            <li key={check.acceptanceId} className={`delivery-check ${check.status}`} title={check.reason}>
              <span className="delivery-check-mark" aria-hidden>
                {check.status === 'passed' ? '✓' : check.status === 'failed' ? '✗' : check.status === 'manual-pending' ? '…' : '○'}
              </span>
              <span className="delivery-check-id">{check.acceptanceId}</span>
              <span className="delivery-check-text">{item?.criterion ?? check.acceptanceId}</span>
            </li>
          )
        })}
      </ul>

      {delivery.waivers.length
        ? <div className="delivery-sub">已豁免：{delivery.waivers.join('、')}</div>
        : null}
      {blocked
        ? <div className="delivery-hint">交付门禁会阻断回合，直到缺口被证据覆盖</div>
        : null}
      {verdict === 'unsure' && delivery.reason
        ? <div className="delivery-hint">未判定原因：{delivery.reason}</div>
        : null}
    </div>
  )
}
