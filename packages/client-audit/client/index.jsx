/**
 * Read-only delivery audit inside the console (slot: details.audit).
 *
 * Everything comes from `/api/audit/*`, which serves only client-visible
 * events; this component has no write path at all. The standalone page at
 * `/audit/:id` stays the customer-facing entry — it does not boot this bundle.
 */

const STYLES = `
.audit-card { display: flex; flex-direction: column; gap: 7px; padding: 2px 12px 12px; }
.audit-head { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; }
.audit-verdict { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); }
.audit-verdict .dot { width: 7px; height: 7px; border-radius: 50%; background: #9ca3af; }
.audit-verdict.pass .dot { background: var(--ok, #2e9e5b); }
.audit-verdict.fail .dot { background: var(--danger, #c0392b); }
.audit-verdict.unsure .dot { background: var(--warn, #d08b1e); }
.audit-muted { color: var(--faint, #6b7280); font-size: 11px; }
.audit-rows { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.audit-row { display: flex; gap: 6px; font-size: 11.5px; align-items: baseline; }
.audit-row .mark { width: 12px; flex: none; }
.audit-row.passed .mark { color: var(--ok, #2e9e5b); }
.audit-row.failed .mark { color: var(--danger, #c0392b); }
.audit-row.missing .mark, .audit-row.manual-pending .mark { color: var(--warn, #d08b1e); }
.audit-entry { display: flex; gap: 8px; font-size: 11px; color: var(--muted); border-top: 1px dashed var(--border); padding-top: 4px; }
.audit-entry .seq { width: 40px; flex: none; color: var(--faint); }
.audit-empty { font-size: 11.5px; color: var(--faint); }
`

function ensureStyles() {
  if (document.getElementById('client-audit-styles')) return
  const style = document.createElement('style')
  style.id = 'client-audit-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}

async function get(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

function AuditPanel({ sessionId }) {
  const React = window.__RBU__.React
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const base = `/api/audit/${encodeURIComponent(sessionId)}`
    Promise.all([get(`${base}/summary`), get(`${base}/acceptance`), get(`${base}/timeline`)])
      .then(([summary, acceptance, timeline]) => {
        if (cancelled) return
        setData({ summary, acceptance, timeline })
        setError(null)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (!sessionId) return null
  if (error) return <div className="audit-card"><div className="audit-empty">审计视图不可用：{error}</div></div>
  if (!data) return <div className="audit-card"><div className="audit-empty">读取中…</div></div>

  const verdict = data.summary.verdict.status
  const checks = data.acceptance.checks ?? []
  const entries = (data.timeline.entries ?? []).slice(-8).reverse()

  return (
    <div className="audit-card">
      <div className="audit-head">
        <span className={`audit-verdict ${verdict}`}>
          <span className="dot" />
          {verdict === 'pass' ? '已通过' : verdict === 'unsure' ? '未判定' : '未通过'}
        </span>
        <span className="audit-muted">
          {data.summary.verdict.accepted}/{data.summary.verdict.total} 条验收
        </span>
      </div>
      {checks.length
        ? (
          <ul className="audit-rows">
            {checks.map(check => (
              <li key={check.acceptanceId} className={`audit-row ${check.status}`} title={check.reason}>
                <span className="mark">{check.status === 'passed' ? '✓' : check.status === 'failed' ? '✗' : '○'}</span>
                <span>{check.acceptanceId}</span>
                <span className="audit-muted">{check.reason}</span>
              </li>
            ))}
          </ul>
        )
        : <div className="audit-empty">本会话没有验收条款</div>}
      {entries.map(entry => (
        <div key={entry.seq} className="audit-entry">
          <span className="seq">#{entry.seq}</span>
          <span>{entry.summary}</span>
        </div>
      ))}
      <div className="audit-muted">客户入口：/audit/{sessionId}</div>
    </div>
  )
}

export default function register(api) {
  ensureStyles()
  return api.slots.register('details.audit', {
    id: 'client-audit.panel',
    order: 40,
    component: AuditPanel,
  })
}
