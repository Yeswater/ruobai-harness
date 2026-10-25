/**
 * Sandbox status panel (client half).
 *
 * Rendered in two host slots: Settings → 沙箱 (full) and the Context view's
 * right column (compact). Policy stays read-only; only the per-session
 * escalation switch is interactive (see docs/sandbox-macos.md §7).
 */

const STYLES = `
.sandbox-card { display: flex; flex-direction: column; gap: 2px; }
.sandbox-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sandbox-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
.sandbox-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); }
.sandbox-dot.ok { background: var(--ok); }
.sandbox-card h4 { margin: 12px 0 4px; font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: .02em; }
.sandbox-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 5px 0; }
.sandbox-mono { font-family: var(--mono); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.sandbox-hint { color: var(--faint); font-size: 11px; }
.sandbox-danger { color: var(--danger); font-size: 11.5px; margin: 6px 0; }
.sandbox-link { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-size: 11.5px; cursor: pointer; }
.sandbox-link:hover { text-decoration: underline; }
.sandbox-btn {
  height: 24px; padding: 0 9px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel); color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer;
}
.sandbox-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.sandbox-btn:disabled { opacity: .45; cursor: not-allowed; }
.sandbox-btn-on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
.sandbox-btn-warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
.sandbox-guards, .sandbox-denials { list-style: none; margin: 4px 0 0; padding: 0; }
.sandbox-guards li {
  display: grid; grid-template-columns: 92px 38px minmax(0, 1fr); gap: 8px; align-items: baseline;
  padding: 4px 0; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.sandbox-guards li:first-child, .sandbox-denials li:first-child { border-top: 0; }
.sandbox-guards code { font-family: var(--mono); font-size: 11px; color: var(--text); overflow-wrap: anywhere; }
.sandbox-guards li > span:nth-child(2) { font-size: 10.5px; color: var(--muted); }
.sandbox-denials li { padding: 5px 0; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.sandbox-denials code { font-family: var(--mono); font-size: 11px; }
.sandbox-details > summary { cursor: pointer; font-size: 11.5px; color: var(--muted); margin-top: 4px; }
.sandbox-details > summary:hover { color: var(--text); }
`

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById('sandbox-panel-styles')) return
  const style = document.createElement('style')
  style.id = 'sandbox-panel-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}
ensureStyles()

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function patchJson(url, payload) {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

const KIND_LABEL = {
  'fs-read-guarded': '读守卫',
  'fs-write-guarded': '写守卫',
  'fs-write-outside': '越界写',
  'network-outbound': '网络',
  'process-exec': '执行',
  'process-control': '进程',
  'mach-lookup': '服务',
  appleevent: '自动化',
  unknown: '未知',
}

function shortDigest(value) {
  return value ? `${String(value).slice(0, 8)}…` : '—'
}

function relative(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m 前`
  return `${Math.round(seconds / 3600)}h 前`
}

function GuardList(props) {
  const { guards, limit } = props
  const shown = limit ? guards.slice(0, limit) : guards
  return (
    <ul className="sandbox-guards">
      {shown.map((guard) => (
        <li key={guard.id}>
          <code>{guard.id}</code>
          <span>{guard.access === 'read' ? '禁读' : '禁写'}</span>
          <span className="sandbox-mono">{guard.path}</span>
        </li>
      ))}
    </ul>
  )
}

function DenialList(props) {
  const { denials } = props
  if (!denials.length) return <p className="sandbox-hint">暂无</p>
  return (
    <ul className="sandbox-denials">
      {denials.map((entry) => (
        <li key={entry.id}>
          <div className="sandbox-line">
            <code>{KIND_LABEL[entry.kind] || entry.kind}</code>
            <span className="sandbox-hint">{relative(entry.at)} · {entry.confidence}</span>
          </div>
          {entry.target ? <div className="sandbox-mono">{entry.target}</div> : null}
        </li>
      ))}
    </ul>
  )
}

function SandboxPanel(props) {
  const { useCallback, useEffect, useState } = React
  const sessionId = props.sessionId || ''
  const compact = props.variant === 'context'
  const sessionQuery = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const body = await getJson(`/api/sandbox/status${sessionQuery}`)
      setStatus(body.status)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [sessionQuery])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  const setMode = useCallback(async (mode) => {
    if (!sessionId) return
    try {
      await patchJson(`/api/sandbox/session${sessionQuery}`, { mode })
      await load()
    } catch (err) {
      setError(err.message)
    }
  }, [load, sessionId, sessionQuery])

  const revoke = useCallback(async () => {
    try {
      await fetch('/api/sandbox/grants', { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(err.message)
    }
  }, [load])

  const active = Boolean(status && status.active)
  const recent = status ? (compact ? status.denials.recent.slice(0, 3) : status.denials.recent) : []
  const guardLimit = compact ? 6 : undefined

  return (
    <div className="sandbox-card">
      {error ? <p className="sandbox-danger">状态不可用：{error}</p> : null}
      {!status ? <p className="sandbox-hint">读取中…</p> : null}
      {status
        ? (
          <>
            <div className="sandbox-card-head">
              <span className="sandbox-status">
                <span className={active ? 'sandbox-dot ok' : 'sandbox-dot'} />
                {active ? '生效' : '未生效'}
                {' · '}{status.guards.length} 守卫
                {' · '}{status.denials.total} 拒绝
              </span>
              <span className="sandbox-mono" title={status.provider?.profileDigest}>
                {status.provider?.id ?? 'no provider'}
              </span>
            </div>
            <p className="sandbox-line">
              <span className="sandbox-mono">profile {shortDigest(status.provider?.profileDigest)}</span>
              <span>网络 {status.policy.network.mode}</span>
            </p>
            {!active
              ? (
                <p className="sandbox-danger">
                  没有可用后端，命令会被拒绝（fail-closed）。请检查 @ruobai/sandbox-macos。
                </p>
              )
              : null}

            <h4>本会话升级策略</h4>
            <p className="sandbox-line">
              <button
                type="button"
                className={status.escalation.mode === 'auto' ? 'sandbox-btn sandbox-btn-on' : 'sandbox-btn'}
                disabled={!sessionId}
                onClick={() => setMode('auto')}
              >升级审批</button>
              <button
                type="button"
                className={status.escalation.mode === 'never' ? 'sandbox-btn sandbox-btn-warn' : 'sandbox-btn'}
                disabled={!sessionId}
                onClick={() => setMode('never')}
              >只报告</button>
              <span className="sandbox-hint">
                {sessionId ? '仅本会话，不写设置；沙箱本身始终生效' : '打开一个会话后可按会话切换'}
              </span>
            </p>

            {status.escalation.sessionGrants.length
              ? (
                <p className="sandbox-line">
                  已授权 {status.escalation.sessionGrants.length} 项
                  <button type="button" className="sandbox-link" onClick={revoke}>全部撤销</button>
                </p>
              )
              : null}

            <h4>守卫（{status.guards.length}）</h4>
            {compact
              ? (
                <details className="sandbox-details">
                  <summary>展开守卫清单</summary>
                  <GuardList guards={status.guards} />
                </details>
              )
              : <GuardList guards={status.guards} limit={guardLimit} />}

            <h4>拒绝记录（{status.denials.total}）</h4>
            <DenialList denials={recent} />
          </>
        )
        : null}
    </div>
  )
}

function SettingsSandbox(props) {
  return <SandboxPanel {...props} variant="settings" />
}

function ContextSandbox(props) {
  return <SandboxPanel {...props} variant="context" />
}

export default function register(api) {
  api.slots.register('settings.sandbox', {
    id: 'sandbox.settings',
    component: SettingsSandbox,
  })
  api.slots.register('context.sandbox', {
    id: 'sandbox.context',
    component: ContextSandbox,
  })
}
