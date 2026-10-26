/**
 * Settings → 门禁. Status, layer switches, read-only command list, L2 provider
 * selection and recent runs. Commands and baseline protections stay read-only:
 * only budgets, policies and the audit provider are editable here.
 */

const STYLES = `
.hook-page { display: flex; flex-direction: column; gap: 14px; }
.hook-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.hook-badge { font-size: 11.5px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.hook-badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.hook-badge.off { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
.hook-chips { display: flex; gap: 8px; font-size: 11.5px; color: var(--muted); }
.hook-rate { font-size: 11.5px; color: var(--muted); }
.hook-btn { height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer; }
.hook-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.hook-btn:disabled { opacity: .45; cursor: not-allowed; }
.hook-section { border-top: 1px solid var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.hook-section-head { display: flex; align-items: baseline; gap: 8px; }
.hook-section-head h3 { margin: 0; font-size: 12px; font-weight: 600; }
.hook-section-head span { font-size: 11px; color: var(--faint); }
.hook-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; font-size: 11.5px; color: var(--muted); }
.hook-row label { display: inline-flex; align-items: center; gap: 5px; }
.hook-row input[type=number] { width: 64px; }
.hook-row input, .hook-row select, .hook-input, .hook-textarea {
  height: 24px; padding: 0 6px; border: 1px solid var(--border); border-radius: 5px;
  background: var(--panel); color: var(--text); font: inherit; font-size: 11.5px;
}
.hook-textarea { height: auto; min-height: 54px; padding: 6px; width: 100%; resize: vertical; font-family: var(--mono); }
.hook-commands { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.hook-commands li { display: grid; grid-template-columns: 110px minmax(0, 1fr) 44px; gap: 8px; align-items: baseline; font-size: 11px; color: var(--muted); }
.hook-commands code { font-family: var(--mono); color: var(--text); overflow-wrap: anywhere; }
.hook-commands em { font-style: normal; font-size: 10.5px; color: var(--faint); }
.hook-empty { font-size: 11.5px; color: var(--faint); }
.hook-note { font-size: 11px; color: var(--faint); }
.hook-error { font-size: 11.5px; color: var(--danger); }
.hook-run { border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); padding: 5px 0; }
.hook-run summary { display: flex; flex-wrap: wrap; gap: 10px; cursor: pointer; font-size: 11.5px; color: var(--muted); }
.hook-run .ok { color: var(--ok); }
.hook-run .bad { color: var(--warn); }
.hook-diags { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.hook-diags li { font-size: 11px; color: var(--muted); }
.hook-diags code { font-family: var(--mono); font-size: 10.5px; color: var(--text); }
.hook-actions { display: flex; gap: 8px; flex-wrap: wrap; }
`

function ensureStyles() {
  if (document.getElementById('hooks-settings-styles')) return
  const style = document.createElement('style')
  style.id = 'hooks-settings-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}

async function request(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
  return payload
}

function splitLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function formatTime(at) {
  try {
    return new Date(at).toLocaleTimeString()
  } catch {
    return ''
  }
}

function LayerSection({
  title,
  hint,
  layer,
  config,
  commands,
  busy,
  onPatch,
  onDry,
}) {
  const enabled = config?.enabled !== false
  const failure = config?.failure === 'close' ? 'close' : 'open'
  return (
    <section className="hook-section">
      <div className="hook-section-head">
        <h3>{title}</h3>
        <span>{hint}</span>
      </div>
      <div className="hook-row">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) =>
              onPatch({ [layer]: { enabled: event.target.checked } })
            }
          />
          启用
        </label>
        <label>
          超时
          <input
            type="number"
            min="100"
            step="100"
            defaultValue={
              config?.timeoutMs ?? (layer === 'edit' ? 4000 : 120000)
            }
            onBlur={(event) =>
              onPatch({ [layer]: { timeoutMs: Number(event.target.value) } })
            }
          />
          ms
        </label>
        <label>
          失败策略
          <select
            value={failure}
            onChange={(event) =>
              onPatch({ [layer]: { failure: event.target.value } })
            }
          >
            <option value="open">放行</option>
            <option value="close">阻断</option>
          </select>
        </label>
        {layer === 'stop' ? (
          <label>
            最大轮次
            <input
              type="number"
              min="0"
              max="5"
              defaultValue={config?.maxRounds ?? 2}
              onBlur={(event) =>
                onPatch({ [layer]: { maxRounds: Number(event.target.value) } })
              }
            />
          </label>
        ) : null}
        <button
          type="button"
          className="hook-btn"
          onClick={() => onDry(layer)}
          disabled={busy}
        >
          试运行
        </button>
      </div>
      <ul className="hook-commands">
        {commands.length ? (
          commands.map((command) => (
            <li key={`${command.scope}:${command.id}`}>
              <code>{command.id}</code>
              <span>{command.command}</span>
              <em>{command.writes ? '改写' : '只读'}</em>
            </li>
          ))
        ) : (
          <li className="hook-empty">未配置检查命令（在 cordis.yml 中启用）</li>
        )}
      </ul>
    </section>
  )
}

function HooksSettings({ sessionId } = {}) {
  const { useCallback, useEffect, useRef, useState } = React
  const [settings, setSettings] = useState({})
  const [providers, setProviders] = useState([])
  const [status, setStatus] = useState(null)
  const [runs, setRuns] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dry, setDry] = useState(null)
  const [auditResult, setAuditResult] = useState(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const timer = useRef(null)

  useEffect(() => {
    ensureStyles()
  }, [])

  const loadRuns = useCallback(async () => {
    const [runsData, statusData] = await Promise.all([
      request('/api/hooks/runs?limit=20'),
      request('/api/hooks/status'),
    ])
    setRuns(runsData.runs ?? [])
    setStatus(statusData)
  }, [])

  const load = useCallback(async () => {
    try {
      const [settingsData, runsData, statusData] = await Promise.all([
        request('/api/hooks/settings'),
        request('/api/hooks/runs?limit=20'),
        request('/api/hooks/status'),
      ])
      setSettings(settingsData.settings ?? {})
      setProviders(settingsData.providers ?? [])
      setRuns(runsData.runs ?? [])
      setStatus(statusData)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const source = new EventSource('/api/events')
    const onFrame = () => {
      if (timer.current) return
      timer.current = setTimeout(() => {
        timer.current = null
        void loadRuns().catch(() => undefined)
      }, 300)
    }
    source.addEventListener('hooks', onFrame)
    return () => {
      source.close()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [loadRuns])

  const patch = useCallback(async (partial) => {
    setBusy(true)
    try {
      const data = await request('/api/hooks/settings', {
        method: 'PATCH',
        body: JSON.stringify(partial),
      })
      setSettings(data.settings ?? {})
      setProviders(data.providers ?? [])
      const statusData = await request('/api/hooks/status')
      setStatus(statusData)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  const dryRun = useCallback(
    async (layer) => {
      setBusy(true)
      try {
        const result = await request('/api/hooks/run', {
          method: 'POST',
          body: JSON.stringify({ layer }),
        })
        setDry({ layer, ...result })
        setError(null)
        void loadRuns().catch(() => undefined)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [loadRuns],
  )

  const enabled = settings.enabled !== false
  const editEnabled = enabled && settings.edit?.enabled !== false
  const stopEnabled = enabled && settings.stop?.enabled !== false
  const auditEnabled = settings.audit?.enabled === true
  const audit = settings.audit ?? {}
  const provider = providers.find((item) => item.id === audit.provider)
  const metrics = status?.metrics
  const passRate =
    metrics && metrics.runs
      ? Math.round((metrics.passes / metrics.runs) * 100)
      : null
  const checkers = status?.checkers ?? []

  return (
    <div className="hook-page">
      <div className="hook-head">
        <span className={`hook-badge ${enabled ? 'ok' : 'off'}`}>
          {enabled ? '门禁已启用' : '门禁已暂停'}
        </span>
        <span className="hook-chips">
          <span>编辑时 {editEnabled ? '开' : '关'}</span>
          <span>Stop {stopEnabled ? '开' : '关'}</span>
          <span>L2 {auditEnabled ? '开' : '关'}</span>
        </span>
        {passRate !== null ? (
          <span className="hook-rate">
            通过率 {passRate}% · 平均 {metrics.averageDurationMs}ms
          </span>
        ) : null}
        <button
          type="button"
          className="hook-btn"
          onClick={() => patch({ enabled: !enabled })}
          disabled={busy}
        >
          {enabled ? '全部暂停' : '全部启用'}
        </button>
      </div>

      {error ? <div className="hook-error">{error}</div> : null}

      <LayerSection
        title="编辑时"
        hint="写入后格式化并做增量检查，只回填新问题"
        layer="edit"
        config={settings.edit}
        commands={checkers.filter(
          (item) => item.scope === 'edit' && item.enabled,
        )}
        busy={busy}
        onPatch={patch}
        onDry={dryRun}
      />

      <LayerSection
        title="Stop"
        hint="回合结束前跑全量检查，未通过则继续修复"
        layer="stop"
        config={settings.stop}
        commands={checkers.filter(
          (item) => item.scope === 'stop' && item.enabled,
        )}
        busy={busy}
        onPatch={patch}
        onDry={dryRun}
      />

      <section className="hook-section">
        <div className="hook-section-head">
          <h3>行为守卫</h3>
          <span>保护配置、拦截绕过命令</span>
        </div>
        <div className="hook-row">
          <label>
            <input
              type="checkbox"
              checked={settings.guard?.enabled !== false}
              onChange={(event) =>
                patch({ guard: { enabled: event.target.checked } })
              }
            />
            启用
          </label>
        </div>
        <div className="hook-note">服务端固定的基线（只读）</div>
        <ul className="hook-commands">
          {(status?.guard?.denyWrite ?? []).map((pattern) => (
            <li key={`w:${pattern}`}>
              <code>写入</code>
              <span>{pattern}</span>
              <em>基线</em>
            </li>
          ))}
          {(status?.guard?.denyCommand ?? []).map((pattern) => (
            <li key={`c:${pattern}`}>
              <code>命令</code>
              <span>{pattern}</span>
              <em>基线</em>
            </li>
          ))}
        </ul>
        <div className="hook-note">
          额外保护路径（每行一个，追加在基线之后）
        </div>
        <textarea
          className="hook-textarea"
          placeholder=".ruobai/secrets.json"
          defaultValue={(settings.guard?.denyWrite ?? []).join('\n')}
          onBlur={(event) =>
            patch({ guard: { denyWrite: splitLines(event.target.value) } })
          }
        />
      </section>

      <section className="hook-section">
        <div className="hook-section-head">
          <h3>L2 审计</h3>
          <span>语义检查，只报告不阻断</span>
        </div>
        <div className="hook-row">
          <label>
            <input
              type="checkbox"
              checked={auditEnabled}
              onChange={(event) =>
                patch({ audit: { enabled: event.target.checked } })
              }
            />
            启用
          </label>
          <label>
            提供方
            <select
              value={audit.provider ?? ''}
              onChange={(event) =>
                patch({ audit: { provider: event.target.value } })
              }
            >
              <option value="">跟随默认</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            模型
            <select
              value={audit.model ?? ''}
              onChange={(event) =>
                patch({ audit: { model: event.target.value } })
              }
            >
              <option value="">跟随默认</option>
              {(provider?.models ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            触发
            <select
              value={audit.trigger ?? 'off'}
              onChange={(event) =>
                patch({ audit: { trigger: event.target.value } })
              }
            >
              <option value="off">关闭</option>
              <option value="stop">停止后</option>
              <option value="manual">手动</option>
            </select>
          </label>
        </div>
        <div className="hook-row">
          <label>
            单次文件
            <input
              type="number"
              min="1"
              max="200"
              defaultValue={audit.maxFiles ?? 20}
              onBlur={(event) =>
                patch({ audit: { maxFiles: Number(event.target.value) } })
              }
            />
          </label>
          <label>
            每日预算
            <input
              type="number"
              min="0"
              max="10000"
              defaultValue={audit.dailyBudget ?? 50}
              onBlur={(event) =>
                patch({ audit: { dailyBudget: Number(event.target.value) } })
              }
            />
          </label>
          <button
            type="button"
            className="hook-btn"
            onClick={() => setPromptOpen((open) => !open)}
          >
            {promptOpen ? '收起提示词' : '提示词'}
          </button>
          <button
            type="button"
            className="hook-btn"
            disabled={!sessionId || busy}
            onClick={async () => {
              setBusy(true)
              try {
                const data = await request('/api/hooks/audit', {
                  method: 'POST',
                  body: JSON.stringify({ sessionId }),
                })
                setAuditResult(data.findings ?? [])
                setError(null)
              } catch (caught) {
                setError(
                  caught instanceof Error ? caught.message : String(caught),
                )
              } finally {
                setBusy(false)
              }
            }}
          >
            立即审计
          </button>
        </div>
        {auditEnabled && !audit.provider && !providers.length ? (
          <div className="hook-note">
            还没有可用的模型提供方，先在供应商页添加。
          </div>
        ) : null}
        {promptOpen ? (
          <textarea
            className="hook-textarea"
            placeholder="留空使用内置审计提示词"
            defaultValue={audit.prompt ?? ''}
            onBlur={(event) => patch({ audit: { prompt: event.target.value } })}
          />
        ) : null}
        {auditResult ? (
          <ul className="hook-diags">
            {auditResult.length ? (
              auditResult.map((finding, index) => (
                <li key={`${finding.rule}:${index}`}>
                  <code>
                    {finding.path ?? '(session)'}
                    {finding.line ? `:${finding.line}` : ''}
                  </code>{' '}
                  [{finding.rule}] {finding.message}
                </li>
              ))
            ) : (
              <li>审计没有发现新问题。</li>
            )}
          </ul>
        ) : null}
      </section>

      {dry ? (
        <section className="hook-section">
          <div className="hook-section-head">
            <h3>试运行 · {dry.layer}</h3>
            <span>
              {dry.diagnostics.length} 条 · 新增 {dry.fresh} · 恶化{' '}
              {dry.worsened}
              {' · '}历史 {dry.known} · {dry.durationMs}ms
            </span>
          </div>
          {dry.checkers.map((checker) => (
            <div className="hook-note" key={checker.id}>
              {checker.id} · exit {checker.exitCode ?? '—'}
              {checker.error ? ` · ${checker.error}` : ''}
            </div>
          ))}
          <ul className="hook-diags">
            {dry.diagnostics.slice(0, 10).map((item) => (
              <li key={item.fingerprint}>
                <code>
                  {item.path}
                  {item.line ? `:${item.line}` : ''}
                </code>{' '}
                [{item.rule}] {item.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="hook-section">
        <div className="hook-section-head">
          <h3>最近运行</h3>
          <span>{runs.length}</span>
        </div>
        {runs.length ? (
          runs.map((run) => (
            <details className="hook-run" key={run.id}>
              <summary>
                <span className={run.blocked || run.escalated ? 'bad' : 'ok'}>
                  {run.escalated ? '升级' : run.blocked ? '阻断' : '通过'}
                </span>
                <span>{run.layer}</span>
                <span>{formatTime(run.at)}</span>
                <span>
                  {run.fresh} 新 / {run.total} 总
                </span>
                <span>{run.durationMs}ms</span>
              </summary>
              {run.diagnostics.length ? (
                <ul className="hook-diags">
                  {run.diagnostics.map((item) => (
                    <li key={item.fingerprint}>
                      <code>
                        {item.path}
                        {item.line ? `:${item.line}` : ''}
                      </code>{' '}
                      [{item.rule}] {item.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="hook-empty">无诊断</div>
              )}
            </details>
          ))
        ) : (
          <div className="hook-empty">还没有运行记录。</div>
        )}
      </section>
    </div>
  )
}

export default function register(api) {
  api.slots.register('settings.hooks', {
    id: 'hooks.settings',
    component: HooksSettings,
  })
}
