import { useEffect, useState } from 'react'
import { api, type ModeInfo, type ProviderMode, type PublicProvider, type PublicSettings } from '../api.ts'
import { CloseIcon, PlusIcon } from './Icons.tsx'
import { McpSettings } from './McpSettings.tsx'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

interface Draft {
  id?: string
  name: string
  note: string
  website: string
  baseUrl: string
  apiKey: string
  mode: ProviderMode
  models: string[]
}

function draftOf(provider?: PublicProvider | null): Draft {
  return {
    id: provider?.id,
    name: provider?.name ?? '',
    note: provider?.note ?? '',
    website: provider?.website ?? '',
    baseUrl: provider?.baseUrl ?? 'https://api.deepseek.com/v1',
    apiKey: '',
    mode: provider?.mode ?? 'direct',
    models: provider?.models.map(model => model.id) ?? [],
  }
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [defaultModel, setDefaultModel] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<'providers' | 'mcp' | 'behavior'>('providers')
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [agentMode, setAgentMode] = useState('agent')
  const [bypass, setBypass] = useState(false)
  const [compactAt, setCompactAt] = useState(48_000)

  const providers = settings?.llm?.providers ?? []
  const activeProvider = settings?.llm?.activeProvider ?? 'mock'
  const activeModel = settings?.llm?.activeModel ?? ''
  const selected = providers.find(provider => provider.id === selectedId)

  const load = async (selectId?: string) => {
    const next = await api.getSettings()
    setSettings(next)
    setAgentMode(next.agent?.defaultMode ?? 'agent')
    setBypass(Boolean(next.agent?.bypassApprovals))
    setCompactAt(next.agent?.compactAt ?? 48_000)
    const list = next.llm?.providers ?? []
    const target = list.find(provider => provider.id === selectId)
      ?? list.find(provider => provider.id === next.llm?.activeProvider)
      ?? list[0]
    setSelectedId(target?.id ?? null)
    setDraft(draftOf(target))
    setDefaultModel(
      target && target.id === next.llm?.activeProvider
        ? next.llm?.activeModel ?? target.models[0]?.id ?? ''
        : target?.models[0]?.id ?? '',
    )
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setNotice(null)
    setBusy(null)
    setModelInput('')
    setTab('providers')
    void load().catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
    })
    void api.getModes()
      .then(({ modes: list }) => {
        if (!cancelled) setModes(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) return null

  const patch = (partial: Partial<Draft>) => {
    setDraft(current => current ? { ...current, ...partial } : current)
  }

  const selectProvider = (provider: PublicProvider) => {
    setSelectedId(provider.id)
    setDraft(draftOf(provider))
    setDefaultModel(
      provider.id === activeProvider ? activeModel || provider.models[0]?.id || '' : provider.models[0]?.id ?? '',
    )
    setError(null)
    setNotice(null)
  }

  const addProvider = () => {
    setSelectedId(null)
    setDraft(draftOf(null))
    setDefaultModel('')
    setError(null)
    setNotice(null)
  }

  const addModel = () => {
    const id = modelInput.trim()
    if (!id || !draft) return
    patch({ models: [...new Set([...draft.models, id])] })
    setModelInput('')
    if (!defaultModel) setDefaultModel(id)
  }

  const removeModel = (id: string) => {
    if (!draft) return
    const models = draft.models.filter(model => model !== id)
    patch({ models })
    if (defaultModel === id) setDefaultModel(models[0] ?? '')
  }

  const fetchModels = async () => {
    if (!draft) return
    setBusy('models')
    setError(null)
    setNotice(null)
    try {
      const models = await api.fetchProviderModels({
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
        id: draft.id,
      })
      const merged = [...new Set([...draft.models, ...models.map(model => model.id)])]
      patch({ models: merged })
      if (!defaultModel && merged[0]) setDefaultModel(merged[0])
      setNotice(`获取到 ${models.length} 个模型`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!draft) return
    setBusy('save')
    setError(null)
    setNotice(null)
    try {
      const input = {
        name: draft.name.trim(),
        note: draft.note.trim() || undefined,
        website: draft.website.trim() || undefined,
        baseUrl: draft.baseUrl.trim(),
        mode: draft.mode,
        models: draft.models,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      }
      const next = draft.id
        ? await api.updateProvider(draft.id, input)
        : await api.createProvider(input)
      const saved = draft.id
        ? next.llm?.providers.find(provider => provider.id === draft.id)
        : next.llm?.providers.find(provider => provider.name === input.name && provider.baseUrl === input.baseUrl)
      setSettings(next)
      if (saved) {
        setSelectedId(saved.id)
        setDraft(draftOf(saved))
        setDefaultModel(
          saved.id === next.llm?.activeProvider ? next.llm?.activeModel ?? '' : saved.models[0]?.id ?? '',
        )
      }
      setNotice('已保存')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!draft?.id) return
    if (!confirm(`删除供应商「${draft.name}」？`)) return
    setBusy('delete')
    setError(null)
    try {
      const next = await api.deleteProvider(draft.id)
      setSettings(next)
      const target = next.llm?.providers[0]
      setSelectedId(target?.id ?? null)
      setDraft(draftOf(target))
      setDefaultModel(target?.models[0]?.id ?? '')
      setNotice('已删除')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const activate = async () => {
    if (!draft?.id) return
    setBusy('activate')
    setError(null)
    setNotice(null)
    try {
      const next = await api.activateProvider(draft.id, defaultModel || undefined)
      setSettings(next)
      setNotice('已设为当前供应商，新建会话生效')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const saveBehavior = async () => {
    setBusy('behavior')
    setError(null)
    setNotice(null)
    try {
      const next = await api.updateSettings({
        agent: {
          defaultMode: agentMode,
          bypassApprovals: bypass,
          compactAt: Number(compactAt) || 48_000,
        },
      })
      setSettings(next)
      setNotice('已保存。默认模式对新建会话生效。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Model providers">
        <div className="modal-head">
          <div>
            <h2>设置</h2>
            <div className="modal-sub">
              当前默认：{activeProvider === 'mock' ? 'Mock（离线）' : activeProvider}
              {activeModel ? ` · ${activeModel}` : ''}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings"><CloseIcon /></button>
        </div>

        <div className="settings-tabs">
          <button className={`tab ${tab === 'providers' ? 'active' : ''}`} onClick={() => setTab('providers')}>供应商</button>
          <button className={`tab ${tab === 'mcp' ? 'active' : ''}`} onClick={() => setTab('mcp')}>MCP</button>
          <button className={`tab ${tab === 'behavior' ? 'active' : ''}`} onClick={() => setTab('behavior')}>行为与权限</button>
        </div>

        {tab === 'providers' ? (
        <div className="settings-grid">
          <aside className="provider-list">
            <button className="new-session provider-add" onClick={addProvider}>
              <PlusIcon size={15} />
              <span>添加供应商</span>
            </button>

            {providers.map(provider => (
              <button
                key={provider.id}
                className={`provider-item ${selectedId === provider.id ? 'active' : ''}`}
                onClick={() => selectProvider(provider)}
              >
                <span className="provider-item-head">
                  <span className="provider-name">{provider.name}</span>
                  {activeProvider === provider.id ? <span className="badge">当前</span> : null}
                </span>
                <span className="provider-url">{provider.baseUrl}</span>
                <span className="provider-meta">
                  {provider.models.length} 个模型 · {provider.hasApiKey ? '已配置密钥' : '未配置密钥'}
                </span>
              </button>
            ))}

            <div className="provider-list-note">
              供应商配置保存在服务端，密钥只写不读。新建会话使用“当前”供应商。
            </div>
          </aside>

          <section className="provider-form">
            {draft
              ? (
                <>
                  <div className="form-row two">
                    <label className="field">
                      <span>名称 *</span>
                      <input value={draft.name} onChange={event => patch({ name: event.target.value })} placeholder="例如：DeepSeek 官方" />
                    </label>
                    <label className="field">
                      <span>备注</span>
                      <input value={draft.note} onChange={event => patch({ note: event.target.value })} placeholder="例如：公司专用账号" />
                    </label>
                  </div>

                  <label className="field">
                    <span>官网链接</span>
                    <input value={draft.website} onChange={event => patch({ website: event.target.value })} placeholder="https://platform.deepseek.com" />
                  </label>

                  <label className="field">
                    <span>API Key {selected?.hasApiKey ? '（已保存）' : '*'}</span>
                    <input
                      type="password"
                      value={draft.apiKey}
                      onChange={event => patch({ apiKey: event.target.value })}
                      placeholder={selected?.hasApiKey ? '已保存，留空保持不变' : 'sk-…'}
                      autoComplete="off"
                    />
                  </label>

                  <label className="field">
                    <span>请求地址 *</span>
                    <input value={draft.baseUrl} onChange={event => patch({ baseUrl: event.target.value })} placeholder="https://api.deepseek.com/v1" />
                  </label>
                  <p className="field-help">OpenAI 兼容的服务地址，不要以斜杠结尾。</p>

                  <div className="form-row two">
                    <label className="field">
                      <span>接入方式</span>
                      <select value={draft.mode} onChange={event => patch({ mode: event.target.value as ProviderMode })}>
                        <option value="direct">直连</option>
                        <option value="mapping">模型映射</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>默认模型</span>
                      <select value={defaultModel} onChange={event => setDefaultModel(event.target.value)}>
                        {draft.models.map(model => <option key={model} value={model}>{model}</option>)}
                        {draft.models.length === 0 ? <option value="">（先添加模型）</option> : null}
                      </select>
                    </label>
                  </div>

                  <div className="model-head">
                    <span>模型列表</span>
                    <button className="btn ghost" onClick={fetchModels} disabled={busy !== null}>
                      {busy === 'models' ? '获取中…' : '获取模型列表'}
                    </button>
                  </div>

                  <div className="model-add">
                    <input
                      value={modelInput}
                      onChange={event => setModelInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          addModel()
                        }
                      }}
                      placeholder="deepseek-chat"
                    />
                    <button className="btn ghost" onClick={addModel} disabled={!modelInput.trim()}>添加</button>
                  </div>

                  <div className="model-chips">
                    {draft.models.map(model => (
                      <span className="model-chip" key={model}>
                        {model}
                        <button onClick={() => removeModel(model)} aria-label={`Remove ${model}`}>×</button>
                      </span>
                    ))}
                    {draft.models.length === 0 ? <span className="muted">还没有模型，先获取或手动添加。</span> : null}
                  </div>

                  <p className="field-help">
                    “获取模型列表”会请求 <code>{draft.baseUrl.replace(/\/+$/, '')}/models</code>。
                  </p>

                  {error ? <div className="detail-note error">{error}</div> : null}
                  {notice ? <div className="detail-note">{notice}</div> : null}

                  <div className="provider-actions">
                    {draft.id ? (
                      <button className="btn ghost danger" onClick={remove} disabled={busy !== null}>删除</button>
                    ) : null}
                    <span className="spacer" />
                    {draft.id ? (
                      <button
                        className="btn ghost"
                        onClick={activate}
                        disabled={busy !== null || activeProvider === draft.id}
                      >
                        {activeProvider === draft.id ? '当前供应商' : '设为当前'}
                      </button>
                    ) : null}
                    <button className="btn" onClick={save} disabled={busy !== null}>
                      {busy === 'save' ? '保存中…' : '保存'}
                    </button>
                  </div>
                </>
              )
              : <div className="loading">loading…</div>}
          </section>
        </div>
        ) : tab === 'behavior' ? (
          <div className="behavior-form">
            <label className="field">
              <span>默认模式（新建会话）</span>
              <select value={agentMode} onChange={event => setAgentMode(event.target.value)}>
                {modes.map(mode => (
                  <option key={mode.id} value={mode.id}>
                    {mode.name}{mode.description ? ` — ${mode.description}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="check-field">
              <input type="checkbox" checked={bypass} onChange={event => setBypass(event.target.checked)} />
              <span>
                跳过写操作审批
                <small>开启后写文件/改文件不再询问，风险自负。</small>
              </span>
            </label>

            <label className="field">
              <span>上下文压缩阈值（估算 token）</span>
              <input
                type="number"
                min={1000}
                step={1000}
                value={compactAt}
                onChange={event => setCompactAt(Number(event.target.value))}
              />
            </label>
            <p className="field-help">超过阈值时用当前模型把较早消息总结成摘要事件，保留最近消息。</p>

            {error ? <div className="detail-note error">{error}</div> : null}
            {notice ? <div className="detail-note">{notice}</div> : null}

            <div className="provider-actions">
              <span className="spacer" />
              <button className="btn" onClick={saveBehavior} disabled={busy !== null}>
                {busy === 'behavior' ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        ) : (
          <McpSettings />
        )}
      </div>
    </div>
  )
}
