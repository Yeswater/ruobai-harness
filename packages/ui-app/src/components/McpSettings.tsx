import { useEffect, useState } from 'react'
import { api, type McpApproval, type McpServer } from '../api.ts'
import { PlusIcon } from './Icons.tsx'

interface Draft {
  id?: string
  label: string
  command: string
  args: string
  env: string
  cwd: string
  timeoutMs: number
  approval: McpApproval
  disabled: boolean
  restart: boolean
}

const STATUS_LABEL: Record<McpServer['status'], string> = {
  connected: '已连接',
  connecting: '连接中…',
  error: '连接失败',
  disconnected: '未连接',
}

function draftOf(server?: McpServer | null): Draft {
  return {
    id: server?.id,
    label: server?.label ?? '',
    command: server?.command ?? '',
    args: (server?.args ?? []).join('\n'),
    env: '',
    cwd: server?.cwd ?? '',
    timeoutMs: server?.timeoutMs ?? 60_000,
    approval: server?.approval ?? 'auto',
    disabled: Boolean(server?.disabled),
    restart: server?.restart !== false,
  }
}

function parseLines(text: string) {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

function parseEnv(text: string) {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) throw new Error(`环境变量格式应为 KEY=value：${line}`)
    env[line.slice(0, index).trim()] = line.slice(index + 1)
  }
  return env
}

function dotOf(server: McpServer) {
  if (server.disabled) return 'off'
  if (server.status === 'connected') return 'ok'
  if (server.status === 'connecting') return 'warn'
  if (server.status === 'error') return 'danger'
  return 'off'
}

export function McpSettings() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const selected = draft?.id ? servers.find(server => server.id === draft.id) : undefined

  const applyList = (list: McpServer[], target?: McpServer | null) => {
    setServers(list)
    setDraft(draftOf(target ?? null))
  }

  useEffect(() => {
    let cancelled = false
    void api.getMcpServers()
      .then((list) => {
        if (!cancelled) applyList(list, list[0])
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })

    // Connection state changes outside the settings request (restart, crash),
    // so keep the status fresh while this tab is visible.
    const timer = setInterval(() => {
      void api.getMcpServers()
        .then((list) => {
          if (!cancelled) setServers(list)
        })
        .catch(() => undefined)
    }, 2_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!draft) {
    return (
      <div className="settings-grid">
        <aside className="provider-list">
          <button className="new-session provider-add" onClick={() => setDraft(draftOf(null))}>
            <PlusIcon size={15} />
            <span>添加 MCP 服务</span>
          </button>
          <div className="provider-list-note">还没有配置 MCP 服务。</div>
        </aside>
        <section className="provider-form">
          <div className="loading">loading…</div>
        </section>
      </div>
    )
  }

  const patch = (partial: Partial<Draft>) => {
    setDraft(current => current ? { ...current, ...partial } : current)
  }

  const selectServer = (server: McpServer) => {
    setDraft(draftOf(server))
    setError(null)
    setNotice(null)
  }

  const addServer = () => {
    setDraft(draftOf(null))
    setError(null)
    setNotice(null)
  }

  const save = async () => {
    if (!draft) return
    setBusy('save')
    setError(null)
    setNotice(null)
    try {
      const input = {
        label: draft.label.trim(),
        command: draft.command.trim(),
        args: parseLines(draft.args),
        ...(draft.env.trim() ? { env: parseEnv(draft.env) } : {}),
        cwd: draft.cwd.trim(),
        timeoutMs: Number(draft.timeoutMs) || 60_000,
        approval: draft.approval,
        disabled: draft.disabled,
        restart: draft.restart,
      }
      const list = draft.id
        ? await api.updateMcpServer(draft.id, input)
        : await api.createMcpServer(input)
      const saved = draft.id
        ? list.find(server => server.id === draft.id)
        : list[list.length - 1]
      applyList(list, saved ?? list[0])
      setNotice('已保存，连接状态会自动刷新')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!draft?.id) return
    if (!confirm(`删除 MCP 服务「${draft.label || draft.id}」？`)) return
    setBusy('delete')
    setError(null)
    try {
      const list = await api.deleteMcpServer(draft.id)
      applyList(list, list[0])
      setNotice('已删除')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const reconnect = async () => {
    if (!draft?.id) return
    setBusy('reconnect')
    setError(null)
    setNotice(null)
    try {
      await api.reconnectMcpServer(draft.id)
      setServers(await api.getMcpServers())
      setNotice('已重新连接')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const clearEnv = async () => {
    if (!draft?.id) return
    setBusy('env')
    setError(null)
    try {
      const list = await api.updateMcpServer(draft.id, { env: {} })
      applyList(list, list.find(server => server.id === draft.id))
      setNotice('已清除环境变量')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings-grid">
      <aside className="provider-list">
        <button className="new-session provider-add" onClick={addServer}>
          <PlusIcon size={15} />
          <span>添加 MCP 服务</span>
        </button>

        {servers.map(server => (
          <button
            key={server.id}
            className={`provider-item ${draft.id === server.id ? 'active' : ''}`}
            onClick={() => selectServer(server)}
          >
            <span className="provider-item-head">
              <span className="provider-name">{server.label || server.id}</span>
              <span className={`status-dot ${dotOf(server)}`} />
            </span>
            <span className="provider-url">
              {server.command}{server.args.length ? ` ${server.args.join(' ')}` : ''}
            </span>
            <span className="provider-meta">
              {server.disabled ? '已禁用' : STATUS_LABEL[server.status]} · {server.tools.length} 个工具
            </span>
          </button>
        ))}

        <div className="provider-list-note">
          保存后立即热加载，无需重启。工具以 <code>mcp__服务__工具</code> 命名，只在 Agent / Goal 模式下提供。
        </div>
      </aside>

      <section className="provider-form">
        <div className="form-row two">
          <label className="field">
            <span>名称</span>
            <input
              value={draft.label}
              onChange={event => patch({ label: event.target.value })}
              placeholder="filesystem"
            />
          </label>
          <label className="field">
            <span>命令 *</span>
            <input
              value={draft.command}
              onChange={event => patch({ command: event.target.value })}
              placeholder="npx"
            />
          </label>
        </div>

        <label className="field">
          <span>参数（每行一个）</span>
          <textarea
            value={draft.args}
            onChange={event => patch({ args: event.target.value })}
            placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
            rows={3}
          />
        </label>

        <div className="form-row two">
          <label className="field">
            <span>工作目录</span>
            <input
              value={draft.cwd}
              onChange={event => patch({ cwd: event.target.value })}
              placeholder="默认为 harness 启动目录"
            />
          </label>
          <label className="field">
            <span>超时（毫秒）</span>
            <input
              type="number"
              min={1000}
              step={1000}
              value={draft.timeoutMs}
              onChange={event => patch({ timeoutMs: Number(event.target.value) })}
            />
          </label>
        </div>

        <div className="field">
          <span className="mcp-env-head">
            <span>环境变量（每行 KEY=value）</span>
            {selected?.hasEnv ? (
              <button className="link-btn" onClick={clearEnv} disabled={busy !== null}>清除已保存</button>
            ) : null}
          </span>
          <textarea
            value={draft.env}
            onChange={event => patch({ env: event.target.value })}
            placeholder={selected?.hasEnv ? '留空则保持现有变量' : 'API_KEY=...'}
            rows={3}
          />
        </div>
        <p className="field-help">
          {selected?.hasEnv
            ? `已保存 ${selected.envKeys.length} 个变量（${selected.envKeys.join(', ')}）；填写内容会整体替换。`
            : '变量只保存在服务端，不会回传给浏览器。'}
        </p>

        <label className="field">
          <span>审批策略</span>
          <select
            value={draft.approval}
            onChange={event => patch({ approval: event.target.value as McpApproval })}
          >
            <option value="auto">自动 — 只读工具免审批</option>
            <option value="always">每次调用都审批</option>
            <option value="never">从不审批</option>
          </select>
        </label>

        <div className="check-row">
          <label className="check-field">
            <input
              type="checkbox"
              checked={!draft.disabled}
              onChange={event => patch({ disabled: !event.target.checked })}
            />
            <span>
              启用此服务
              <small>禁用会断开连接并移除它的工具，配置保留。</small>
            </span>
          </label>

          <label className="check-field">
            <input
              type="checkbox"
              checked={draft.restart}
              onChange={event => patch({ restart: event.target.checked })}
            />
            <span>
              异常退出后自动重启
              <small>按 1s、2s、4s… 退避，最长 30 秒。</small>
            </span>
          </label>
        </div>

        {selected ? (
          <div className="mcp-status-panel">
            <div className="mcp-status-line">
              <span className={`status-dot ${dotOf(selected)}`} />
              <strong>{selected.disabled ? '已禁用' : STATUS_LABEL[selected.status]}</strong>
              {selected.pid ? <span className="hint">pid {selected.pid}</span> : null}
              <span className="muted">{selected.tools.length} 个工具</span>
            </div>
            {selected.error ? <div className="mcp-error">{selected.error}</div> : null}
            {selected.tools.length ? (
              <div className="model-chips">
                {selected.tools.map(name => <span className="model-chip" key={name}>{name}</span>)}
              </div>
            ) : <span className="hint">尚未发现工具。</span>}
            <div className="hint">
              调用名为 <code>mcp__{selected.id}__工具名</code>。
            </div>
          </div>
        ) : null}

        {error ? <div className="detail-note error">{error}</div> : null}
        {notice ? <div className="detail-note">{notice}</div> : null}

        <div className="provider-actions">
          {draft.id ? (
            <button className="btn ghost danger" onClick={remove} disabled={busy !== null}>删除</button>
          ) : null}
          <span className="spacer" />
          {draft.id ? (
            <button className="btn ghost" onClick={reconnect} disabled={busy !== null || draft.disabled}>
              {busy === 'reconnect' ? '连接中…' : '重新连接'}
            </button>
          ) : null}
          <button className="btn" onClick={save} disabled={busy !== null || !draft.command.trim()}>
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
        </div>
      </section>
    </div>
  )
}
