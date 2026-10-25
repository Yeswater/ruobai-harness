/**
 * Sandbox status panel (client half).
 *
 * `React` is injected by the host runtime (classic JSX runtime), so this file
 * uses JSX without importing anything. Mounted into `header.actions`.
 *
 * Read-only except for the per-session escalation switch: policy editing is
 * intentionally absent — a guard or network change is a reviewed file edit,
 * not a click (see docs/sandbox-macos.md §7).
 */

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
  'fs-read-guarded': '读守卫文件',
  'fs-write-guarded': '写守卫文件',
  'fs-write-outside': '越界写',
  'network-outbound': '出站网络',
  'process-exec': '进程执行',
  'process-control': '进程控制',
  'mach-lookup': 'mach 服务',
  appleevent: '自动化',
  unknown: '未识别',
}

function shortDigest(digest) {
  return digest ? `${digest.slice(0, 10)}…` : 'n/a'
}

function relative(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m 前`
  return `${Math.round(seconds / 3600)}h 前`
}

function SandboxPanel(props) {
  const { useCallback, useEffect, useState } = React
  // Injected by the host `Slot`; without it the switch has no session to bind to.
  const sessionId = (props && props.sessionId) || ''
  const sessionQuery = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const [open, setOpen] = useState(false)
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
  const label = error ? '沙箱 ?' : active ? '沙箱 生效' : status ? '沙箱 未生效' : '沙箱 …'

  return (
    <div className="sandbox-root">
      <button
        type="button"
        className={active ? 'sandbox-chip sandbox-chip-ok' : 'sandbox-chip sandbox-chip-danger'}
        onClick={() => setOpen(value => !value)}
        title={status?.provider?.profileDigest ?? ''}
      >
        {label}
        {status ? ` · ${status.guards.length} 守卫 · ${status.denials.total} 拒绝` : ''}
      </button>
      {open ? (
        <div className="sandbox-drawer">
          <header className="sandbox-drawer-head">
            <strong>macOS 沙箱</strong>
            <button type="button" className="sandbox-link" onClick={() => setOpen(false)}>关闭</button>
          </header>
          {error ? <p className="sandbox-danger">状态不可用：{error}</p> : null}
          {status ? (
            <>
              <p className="sandbox-line">
                <code>{status.provider?.id ?? 'no provider'}</code>
                <span className="sandbox-mono" title={status.provider?.profileDigest}>
                  profile {shortDigest(status.provider?.profileDigest)}
                </span>
                <span>网络 {status.policy.network.mode}</span>
              </p>
              {!active ? (
                <p className="sandbox-danger">
                  没有可用后端，命令会被拒绝（fail-closed）。请检查 @ruobai/sandbox-macos。
                </p>
              ) : null}

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

              {status.escalation.sessionGrants.length ? (
                <p className="sandbox-line">
                  已授权 {status.escalation.sessionGrants.length} 项
                  <button type="button" className="sandbox-link" onClick={revoke}>全部撤销</button>
                </p>
              ) : null}

              <h4>守卫（{status.guards.length}）</h4>
              <ul className="sandbox-guards">
                {status.guards.map(guard => (
                  <li key={guard.id}>
                    <code>{guard.id}</code>
                    <span>{guard.access === 'read' ? '禁读' : '禁写'}</span>
                    <span className="sandbox-mono">{guard.path}</span>
                  </li>
                ))}
              </ul>

              <h4>拒绝记录（{status.denials.total}）</h4>
              {status.denials.recent.length === 0 ? <p className="sandbox-hint">暂无</p> : (
                <ul className="sandbox-denials">
                  {status.denials.recent.map(entry => (
                    <li key={entry.id}>
                      <div>
                        <strong>{KIND_LABEL[entry.kind] ?? entry.kind}</strong>
                        {entry.guard ? <code>{entry.guard}</code> : null}
                        {entry.repeated > 1 ? <span>×{entry.repeated}</span> : null}
                        <span className="sandbox-hint">{relative(entry.at)} · {entry.confidence}</span>
                      </div>
                      {entry.target ? <div className="sandbox-mono">{entry.target}</div> : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : <p className="sandbox-hint">读取中…</p>}
        </div>
      ) : null}
    </div>
  )
}

export default function register(api) {
  api.slots.register('header.actions', {
    id: 'sandbox.chip',
    order: 20,
    component: SandboxPanel,
  })
}
