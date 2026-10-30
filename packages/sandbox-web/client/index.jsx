/**
 * Sandbox panel (client half).
 *
 * Rendered in two host slots: Settings → 沙箱 (full) and the Context view's
 * right column (compact). The model follows Claude Code: commands that stay
 * inside the sandbox need no approval; the boundary, the domain allowlist and
 * the unsandboxed escape hatch are all editable here.
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
.sandbox-warn { color: var(--warn); font-size: 11.5px; margin: 6px 0; line-height: 1.55; }
.sandbox-confirm {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border)); border-radius: 9px;
  background: color-mix(in srgb, var(--danger) 8%, transparent); font-size: 11.5px; line-height: 1.5;
}
.sandbox-confirm p { flex: 1 1 220px; margin: 0; color: var(--text); }
.sandbox-confirm button {
  height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel); color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer;
}
.sandbox-confirm button.danger { border-color: var(--danger); background: var(--danger); color: #fff; }
.sandbox-switch {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin-bottom: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--panel);
}
.sandbox-switch-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sandbox-switch-copy strong { font-size: 12.5px; color: var(--text); font-weight: 500; }
.sandbox-switch-copy p { margin: 0; font-size: 11px; line-height: 1.5; color: var(--muted); }
.sandbox-toggle {
  position: relative; flex: none; width: 34px; height: 20px; padding: 0;
  border: 1px solid var(--border-strong); border-radius: 999px; background: var(--tool-bg);
  cursor: pointer; transition: background .15s ease, border-color .15s ease;
}
.sandbox-toggle span {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--faint); transition: transform .15s ease, background .15s ease;
}
.sandbox-toggle.on { border-color: var(--accent); background: var(--accent-soft); }
.sandbox-toggle.on span { transform: translateX(14px); background: var(--accent); }
.sandbox-toggle:disabled { opacity: .5; cursor: default; }
.sandbox-field { display: flex; flex-direction: column; gap: 5px; margin: 8px 0; }
.sandbox-field > span { color: var(--muted); font-size: 11.5px; }
.sandbox-field > small { color: var(--faint); font-size: 11px; line-height: 1.5; }
.sandbox-field textarea {
  min-height: 74px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  outline: none; resize: vertical; background: var(--panel); color: var(--text);
  font-family: var(--mono); font-size: 11.5px; line-height: 1.55;
}
.sandbox-field textarea:focus { border-color: var(--accent); }
.sandbox-actions { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; }
.sandbox-btn {
  height: 26px; padding: 0 11px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel); color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer;
}
.sandbox-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.sandbox-btn:disabled { opacity: .45; cursor: not-allowed; }
.sandbox-btn-primary { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
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

function linesOf(value) {
  return String(value || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
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

function Toggle(props) {
  const { label, description, checked, onChange, disabled } = props
  return (
    <div className="sandbox-switch">
      <div className="sandbox-switch-copy">
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`sandbox-toggle${checked ? ' on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  )
}

function SandboxPanel(props) {
  const { useCallback, useEffect, useMemo, useState } = React
  const sessionId = props.sessionId || ''
  const compact = props.variant === 'context'
  const sessionQuery = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const [status, setStatus] = useState(null)
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const body = await getJson(`/api/sandbox/status${sessionQuery}`)
      setStatus(body.status)
      setError(null)
      if (!dirty && body.status.settings) setDraft(body.status.settings)
    } catch (err) {
      setError(err.message)
    }
  }, [sessionQuery, dirty])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  const update = useCallback((patch) => {
    setDraft((current) => {
      if (!current) return current
      const next = { ...current, ...patch }
      if (patch.network) next.network = { ...current.network, ...patch.network }
      if (patch.filesystem) next.filesystem = { ...current.filesystem, ...patch.filesystem }
      return next
    })
    setDirty(true)
    setNotice(null)
  }, [])

  const save = useCallback(async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await patchJson('/api/sandbox/config', {
        autoAllowBashIfSandboxed: draft.autoAllowBashIfSandboxed,
        allowUnsandboxedCommands: draft.allowUnsandboxedCommands,
        excludedCommands: draft.excludedCommands,
        network: draft.network,
        filesystem: draft.filesystem,
      })
      setDirty(false)
      setNotice('已保存，下一次命令生效')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [draft, load])

  const applySandbox = useCallback(async (next) => {
    setConfirming(false)
    try {
      await patchJson('/api/sandbox/config', { enabled: next })
      await load()
    } catch (err) {
      setError(err.message)
    }
  }, [load])

  const toggleSandbox = useCallback(() => {
    if (!status) return
    if (status.enabled === false) {
      void applySandbox(true)
      return
    }
    setConfirming(true)
  }, [applySandbox, status])

  const enabled = status ? status.enabled !== false : true
  const active = Boolean(status && status.active)
  const recent = status ? (compact ? status.denials.recent.slice(0, 3) : status.denials.recent) : []
  const guardLimit = compact ? 6 : undefined
  const proxy = status ? status.proxy : null
  const networkMode = status ? status.policy.network.mode : 'deny'
  const changed = useMemo(() => dirty, [dirty])

  return (
    <div className="sandbox-card">
      {error ? <p className="sandbox-danger">状态不可用：{error}</p> : null}
      {!status ? <p className="sandbox-hint">读取中…</p> : null}
      {status
        ? (
          <>
            {compact
              ? null
              : (
                <Toggle
                  label="沙箱保护"
                  description="命令在 macOS Seatbelt 中执行：写入限定在工作区，网络走下方域名白名单。"
                  checked={enabled}
                  onChange={() => toggleSandbox()}
                />
              )}

            <div className="sandbox-card-head">
              <span className="sandbox-status">
                <span className={enabled && active ? 'sandbox-dot ok' : 'sandbox-dot'} />
                {!enabled ? '已关闭 · 直连执行' : active ? '生效' : '未生效'}
                {enabled ? ` · ${status.guards.length} 守卫 · ${status.denials.total} 拒绝` : ''}
              </span>
              <span className="sandbox-mono" title={status.provider?.profileDigest}>
                {status.provider?.id ?? 'no provider'}
              </span>
            </div>

            {confirming
              ? (
                <div className="sandbox-confirm" role="alertdialog" aria-label="关闭沙箱">
                  <p>关闭后命令不再受 Seatbelt 限制，只受审批规则约束。</p>
                  <button type="button" onClick={() => setConfirming(false)}>取消</button>
                  <button type="button" className="danger" onClick={() => void applySandbox(false)}>关闭沙箱</button>
                </div>
              )
              : null}
            {!enabled && !confirming
              ? <p className="sandbox-warn">沙箱已关闭：命令直连执行，只受审批规则与危险命令保护约束。</p>
              : null}
            {enabled && !active
              ? (
                <p className="sandbox-danger">
                  没有可用后端，命令会被拒绝（fail-closed）。请检查 @ruobai/sandbox-macos。
                </p>
              )
              : null}

            {enabled && draft
              ? (
                <>
                  <p className="sandbox-line">
                    <span className="sandbox-mono">profile {shortDigest(status.provider?.profileDigest)}</span>
                    <span>
                      网络 {networkMode === 'proxy'
                        ? `代理 · ${proxy ? `${proxy.domains} 域名` : '未挂载'}`
                        : networkMode === 'allowlist' ? '端口白名单' : '仅本地回环'}
                    </span>
                    {proxy && proxy.active ? <span className="sandbox-hint">端口 {proxy.port}</span> : null}
                    {proxy && proxy.upstream ? <span className="sandbox-hint">上游 {proxy.upstream}</span> : null}
                  </p>

                  {!compact
                    ? (
                      <>
                        <Toggle
                          label="沙箱内命令免审批"
                          description="命令留在沙箱边界内时直接执行；只有越过边界的命令才询问。危险命令规则仍然生效。"
                          checked={draft.autoAllowBashIfSandboxed !== false}
                          onChange={value => update({ autoAllowBashIfSandboxed: value })}
                        />
                        <Toggle
                          label="允许不经沙箱重试"
                          description="被沙箱拦截时，模型可以在你批准后用 dangerouslyDisableSandbox 重跑一次。"
                          checked={draft.allowUnsandboxedCommands !== false}
                          onChange={value => update({ allowUnsandboxedCommands: value })}
                        />
                        <Toggle
                          label="本地开发服务器"
                          description="允许命令监听和连接 localhost，vite/vitest/回调服务需要。"
                          checked={draft.network.allowLocalBinding !== false}
                          onChange={value => update({ network: { allowLocalBinding: value } })}
                        />

                        <label className="sandbox-field">
                          <span>允许的域名（每行一个，支持 *.example.com 和 host:port）</span>
                          <textarea
                            value={draft.network.allowedDomains.join('\n')}
                            spellCheck={false}
                            onChange={event => update({ network: { allowedDomains: linesOf(event.target.value) } })}
                          />
                          <small>沙箱内只有这些域名（经由本机代理）和本地回环可达；留空表示完全断网。</small>
                        </label>

                        <label className="sandbox-field">
                          <span>排除的命令（每行一个，始终不经沙箱）</span>
                          <textarea
                            value={draft.excludedCommands.join('\n')}
                            spellCheck={false}
                            onChange={event => update({ excludedCommands: linesOf(event.target.value) })}
                          />
                          <small>容器守护进程等无法在沙箱内工作的命令；它们仍然需要审批。</small>
                        </label>

                        <label className="sandbox-field">
                          <span>额外可写目录（每行一个，支持 ~）</span>
                          <textarea
                            value={draft.filesystem.allowWrite.join('\n')}
                            spellCheck={false}
                            onChange={event => update({ filesystem: { allowWrite: linesOf(event.target.value) } })}
                          />
                          <small>默认只有工作区和临时目录可写。</small>
                        </label>

                        <div className="sandbox-actions">
                          <button
                            type="button"
                            className="sandbox-btn sandbox-btn-primary"
                            disabled={!changed || busy}
                            onClick={() => void save()}
                          >
                            {busy ? '保存中…' : '保存策略'}
                          </button>
                          {notice ? <span className="sandbox-hint">{notice}</span> : null}
                          {dirty ? <span className="sandbox-hint">有未保存的修改</span> : null}
                        </div>
                      </>
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
              : (
                <details className="sandbox-details">
                  <summary>查看已配置的守卫（关闭时不生效，{status.guards.length} 项）</summary>
                  <GuardList guards={status.guards} />
                </details>
              )}
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
