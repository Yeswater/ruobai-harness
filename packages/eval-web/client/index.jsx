/**
 * 设置 → 技能页下方的评测门控：任务、最近结果、对比判定。
 *
 * 只读展示 + 一个「判定」动作：判定本身不写 cordis.yml，只落提案或拒绝事件。
 */

const STYLES = `
.eval-panel { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.eval-head { display: flex; align-items: baseline; gap: 8px; }
.eval-head h3 { margin: 0; font-size: 12px; font-weight: 600; }
.eval-head span { font-size: 11px; color: var(--faint); }
.eval-runs { display: flex; flex-wrap: wrap; gap: 6px; }
.eval-run { font-size: 11px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); background: transparent; cursor: pointer; font: inherit; }
.eval-run.active { color: var(--text); border-color: var(--border-strong); }
.eval-empty { font-size: 11.5px; color: var(--faint); }
.eval-row { display: flex; gap: 8px; font-size: 11.5px; align-items: baseline; }
.eval-pass { color: var(--ok, #2e9e5b); }
.eval-fail { color: var(--danger, #c0392b); }
.eval-verdict { font-size: 11.5px; padding: 4px 8px; border-radius: 6px; }
.eval-verdict.accept { color: #1f7a45; background: #e8f5ec; }
.eval-verdict.reject, .eval-verdict.needs-baseline { color: #8a4b0f; background: #fdf0d5; }
`

function ensureStyles() {
  if (document.getElementById('eval-styles')) return
  const style = document.createElement('style')
  style.id = 'eval-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}

async function request(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? `${response.status} ${response.statusText}`)
  return payload
}

function EvalPanel({ sessionId }) {
  const React = window.__RBU__.React
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [verdict, setVerdict] = React.useState(null)
  const [baseline, setBaseline] = React.useState('')
  const [candidate, setCandidate] = React.useState('')

  const load = () => {
    if (!sessionId) return
    request(`/api/evals?sessionId=${encodeURIComponent(sessionId)}`)
      .then((next) => {
        setData(next)
        setError(null)
        const runs = [...new Set((next.results ?? []).map(result => result.runId))]
        setBaseline(previous => previous || runs[0] || '')
        setCandidate(previous => previous || runs[1] || '')
      })
      .catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
  }

  React.useEffect(load, [sessionId])

  const gate = async () => {
    setError(null)
    try {
      const next = await request('/api/evals/judge', {
        method: 'POST',
        body: JSON.stringify({ sessionId, baselineRunId: baseline, candidateRunId: candidate }),
      })
      setVerdict(next.decision)
      load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  if (!sessionId) return null
  if (error) return <div className="eval-empty">评测不可用：{error}</div>
  if (!data) return <div className="eval-empty">读取中…</div>

  const tasks = data.tasks ?? []
  const results = data.results ?? []
  const runs = [...new Set(results.map(result => result.runId))]

  return (
    <div className="eval-panel">
      <div className="eval-head">
        <h3>评测门控</h3>
        <span>{tasks.length} 个任务 · {runs.length} 次运行</span>
      </div>
      {tasks.length
        ? (
          <ul className="rubric-list">
            {tasks.map(task => (
              <li key={task.name} className="eval-row">
                <span>{task.name}</span>
                <span className="eval-empty">{task.command}</span>
              </li>
            ))}
          </ul>
        )
        : <div className="eval-empty">还没有任务。在 .ruobai/evals 放一个 {"{ name, command }"} 的 JSON。</div>}

      {runs.length >= 1
        ? (
          <div className="eval-runs">
            {runs.map(run => (
              <button
                key={run}
                className={`eval-run ${run === baseline ? 'active' : ''}`}
                onClick={() => setBaseline(run)}
                title="设为基线"
              >
                基线 {run}
              </button>
            ))}
            {runs.map(run => (
              <button
                key={`c-${run}`}
                className={`eval-run ${run === candidate ? 'active' : ''}`}
                onClick={() => setCandidate(run)}
                title="设为候选"
              >
                候选 {run}
              </button>
            ))}
          </div>
        )
        : null}

      {runs.length >= 2
        ? (
          <button className="btn ghost compact" onClick={() => void gate()}>
            对比判定
          </button>
        )
        : null}

      {verdict
        ? (
          <div className={`eval-verdict ${verdict.verdict}`}>
            {verdict.verdict === 'accept' ? '通过' : verdict.verdict === 'needs-baseline' ? '缺少基线' : '拒绝'}
            {' · '}{verdict.reason}
          </div>
        )
        : null}

      {results.slice(-6).reverse().map(result => (
        <div key={`${result.runId}-${result.task}-${result.at}`} className="eval-row">
          <span className={result.passed ? 'eval-pass' : 'eval-fail'}>{result.passed ? '通过' : '失败'}</span>
          <span>{result.task}</span>
          <span className="eval-empty">{result.runId}</span>
        </div>
      ))}
    </div>
  )
}

export default function register(api) {
  ensureStyles()
  return api.slots.register('settings.eval', {
    id: 'eval.panel',
    order: 70,
    component: EvalPanel,
  })
}
