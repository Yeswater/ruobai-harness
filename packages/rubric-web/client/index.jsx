/**
 * 门禁页下方的行为诊断：规则、失败、决策点。
 *
 * 只读：数据来自 `GET /api/rubric`，组件没有任何写入路径。
 */

const STYLES = `
.rubric-panel { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.rubric-head { display: flex; align-items: baseline; gap: 8px; }
.rubric-head h3 { margin: 0; font-size: 12px; font-weight: 600; }
.rubric-head span { font-size: 11px; color: var(--faint); }
.rubric-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rubric-rule { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 8px; align-items: baseline; }
.rubric-sev { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); text-align: center; }
.rubric-sev.high { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.rubric-sev.medium { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
.rubric-sev.low { color: var(--muted); }
.rubric-title { font-size: 12px; font-weight: 600; }
.rubric-detail { font-size: 11.5px; color: var(--muted); }
.rubric-empty { font-size: 11.5px; color: var(--faint); }
`

function ensureStyles() {
  if (document.getElementById('rubric-styles')) return
  const style = document.createElement('style')
  style.id = 'rubric-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}

async function get(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

function RubricPanel({ sessionId }) {
  const React = window.__RBU__.React
  const [report, setReport] = React.useState(null)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    if (!sessionId) {
      setReport(null)
      return
    }
    let cancelled = false
    get(`/api/rubric?sessionId=${encodeURIComponent(sessionId)}`)
      .then((next) => {
        if (cancelled) return
        setReport(next)
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
  if (error) return <div className="rubric-empty">诊断不可用：{error}</div>
  if (!report) return <div className="rubric-empty">读取中…</div>

  const rules = report.rules ?? []
  return (
    <div className="rubric-panel">
      <div className="rubric-head">
        <h3>行为诊断</h3>
        <span>
          {rules.length} 条提醒 · {report.decisions?.length ?? 0} 个工具决策 · 裁决 {report.verdict}
        </span>
      </div>
      {rules.length
        ? (
          <ul className="rubric-list">
            {rules.map(rule => (
              <li key={rule.id} className="rubric-rule">
                <span className={`rubric-sev ${rule.severity}`}>
                  {rule.severity === 'high' ? '高' : rule.severity === 'medium' ? '中' : '低'}
                </span>
                <span>
                  <span className="rubric-title">{rule.title}</span>
                  <span className="rubric-detail"> {rule.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )
        : <div className="rubric-empty">这段会话没有发现需要提醒的模式。</div>}
    </div>
  )
}

export default function register(api) {
  ensureStyles()
  return api.slots.register('settings.rubric', {
    id: 'rubric.panel',
    order: 60,
    component: RubricPanel,
  })
}
