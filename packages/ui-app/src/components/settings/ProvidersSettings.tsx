import { useEffect, useState } from 'react'
import {
  api,
  type ProviderInput,
  type ProviderMode,
  type ProviderModel,
  type ProviderPreset,
  type PublicProvider,
  type PublicSettings,
} from '../../api.ts'
import { useConfirm } from '../ConfirmDialog.tsx'
import { CloseIcon, PlusIcon } from '../Icons.tsx'
import { Select } from '../Select.tsx'
import { TokenAmountInput } from '../TokenAmountInput.tsx'

interface ProvidersSettingsProps {
  settings: PublicSettings | null
  onSettingsChange: (settings: PublicSettings) => void
}

interface Draft {
  id?: string
  name: string
  note: string
  website: string
  baseUrl: string
  apiKey: string
  mode: ProviderMode
  models: ProviderModel[]
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
    models: provider?.models.map(model => ({
      ...model,
      // Existing models predate capability metadata; keep images enabled until
      // the user narrows the type explicitly.
      inputTypes: model.inputTypes?.length ? [...model.inputTypes] : ['text', 'image'],
    })) ?? [],
  }
}

export function ProvidersSettings({ settings, onSettingsChange }: ProvidersSettingsProps) {
  const confirm = useConfirm()
  const providers = settings?.llm?.providers ?? []
  const activeProvider = settings?.llm?.activeProvider ?? 'mock'
  const activeModel = settings?.llm?.activeModel ?? ''
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [defaultModel, setDefaultModel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [presetPick, setPresetPick] = useState('')

  useEffect(() => {
    void api.providerPresets().then(setPresets).catch(() => undefined)
  }, [])

  const applyPreset = (presetId: string) => {
    setPresetPick('')
    const preset = presets.find(item => item.id === presetId)
    if (!preset || !draft) return
    // Keep metadata the user already set (context window, output cap) when a
    // model id appears in both lists; templates only carry ids.
    const known = new Map(draft.models.filter(model => model.id).map(model => [model.id, model]))
    patch({
      name: preset.name,
      note: preset.note ?? '',
      website: preset.website ?? '',
      baseUrl: preset.baseUrl,
      models: preset.models.map(model => known.get(model.id) ?? { id: model.id, name: '', inputTypes: ['text'] }),
    })
    setNotice(`已填入 ${preset.name} 的地址与模型，可继续点「拉取模型」确认`)
  }

  const selected = providers.find(provider => provider.id === selectedId)

  // Server settings are authoritative. Prefer the provider the user is
  // editing; fall back to the active one when it disappeared.
  useEffect(() => {
    if (!settings) return
    const list = settings.llm?.providers ?? []
    const target = list.find(provider => provider.id === selectedId)
      ?? list.find(provider => provider.id === settings.llm?.activeProvider)
      ?? list[0]
    setSelectedId(target?.id ?? null)
    setDraft(draftOf(target))
    setDefaultModel(
      target && target.id === settings.llm?.activeProvider
        ? settings.llm?.activeModel ?? target.models[0]?.id ?? ''
        : target?.models[0]?.id ?? '',
    )
  }, [settings])

  if (!settings) return <div className="loading">loading…</div>

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
    if (!draft) return
    patch({ models: [...draft.models, { id: '', name: '', inputTypes: ['text'] }] })
  }

  const updateModel = (index: number, changes: Partial<ProviderModel>) => {
    if (!draft) return
    const models = draft.models.map((model, current) => current === index ? { ...model, ...changes } : model)
    patch({ models })
  }

  const removeModel = (index: number) => {
    if (!draft) return
    const removed = draft.models[index]
    const models = draft.models.filter((_, current) => current !== index)
    patch({ models })
    if (removed?.id && defaultModel === removed.id) {
      setDefaultModel(models.find(model => model.id)?.id ?? '')
    }
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
      const known = new Map(draft.models.filter(model => model.id).map(model => [model.id, model]))
      const merged = [...draft.models]
      for (const model of models) {
        if (!model.id || known.has(model.id)) continue
        const entry: ProviderModel = { id: model.id, inputTypes: ['text'] }
        known.set(model.id, entry)
        merged.push(entry)
      }
      patch({ models: merged })
      if (!defaultModel && models[0]?.id) setDefaultModel(models[0].id)
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
      const seen = new Set<string>()
      const models: ProviderModel[] = []
      for (const model of draft.models) {
        const id = model.id.trim()
        if (!id) continue
        if (seen.has(id)) throw new Error(`模型 ID 重复：${id}`)
        seen.add(id)
        const next: ProviderModel = { id }
        if (model.name?.trim()) next.name = model.name.trim()
        if (model.contextWindow && model.contextWindow > 0) next.contextWindow = Math.floor(model.contextWindow)
        if (model.maxOutputTokens && model.maxOutputTokens > 0) next.maxOutputTokens = Math.floor(model.maxOutputTokens)
        next.inputTypes = model.inputTypes?.length ? model.inputTypes : ['text']
        models.push(next)
      }
      if (defaultModel && !models.some(model => model.id === defaultModel)) {
        setDefaultModel(models[0]?.id ?? '')
      }
      const input: ProviderInput = {
        name: draft.name.trim(),
        note: draft.note.trim() || undefined,
        website: draft.website.trim() || undefined,
        baseUrl: draft.baseUrl.trim(),
        mode: draft.mode,
        models,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      }
      const next = draft.id
        ? await api.updateProvider(draft.id, input)
        : await api.createProvider(input)
      const saved = draft.id
        ? next.llm?.providers.find(provider => provider.id === draft.id)
        : next.llm?.providers.find(provider => provider.name === input.name && provider.baseUrl === input.baseUrl)
      if (saved) {
        setSelectedId(saved.id)
        setDraft(draftOf(saved))
        setDefaultModel(
          saved.id === next.llm?.activeProvider ? next.llm?.activeModel ?? '' : saved.models[0]?.id ?? '',
        )
      }
      onSettingsChange(next)
      setNotice('已保存')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!draft?.id) return
    const ok = await confirm({
      title: '删除供应商',
      body: `「${draft.name}」及其模型配置会一并移除。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    setBusy('delete')
    setError(null)
    try {
      const next = await api.deleteProvider(draft.id)
      const target = next.llm?.providers[0]
      setSelectedId(target?.id ?? null)
      setDraft(draftOf(target))
      setDefaultModel(target?.models[0]?.id ?? '')
      onSettingsChange(next)
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
      onSettingsChange(next)
      setNotice('已设为当前供应商，新建会话生效')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
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
            aria-pressed={selectedId === provider.id}
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
              <div className="settings-form-section">
                <h3 className="settings-form-title">基本信息</h3>
                {presets.length
                  ? (
                    <label className="field">
                      <span>从预设填入</span>
                      <Select
                        value={presetPick}
                        options={[
                          { value: '', label: '选择模板…' },
                          ...presets.map(preset => ({
                            value: preset.id,
                            label: preset.name,
                            description: preset.baseUrl,
                          })),
                        ]}
                        onChange={applyPreset}
                        ariaLabel="从预设填入供应商配置"
                      />
                    </label>
                  )
                  : null}
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
              </div>

              <div className="settings-form-section">
                <h3 className="settings-form-title">连接</h3>
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
                    <Select
                      value={draft.mode}
                      options={[
                        { value: 'direct', label: '直连' },
                        { value: 'mapping', label: '模型映射' },
                      ]}
                      onChange={value => patch({ mode: value as ProviderMode })}
                      ariaLabel="Provider mode"
                      menuWidth={180}
                    />
                  </label>
                  <label className="field">
                    <span>默认模型</span>
                    <Select
                      value={defaultModel}
                      options={draft.models.some(model => model.id)
                        ? draft.models
                            .filter(model => model.id)
                            .map(model => ({ value: model.id, label: model.name || model.id }))
                        : [{ value: '', label: '（先添加模型）' }]}
                      onChange={setDefaultModel}
                      ariaLabel="Default model"
                      menuWidth={220}
                    />
                  </label>
                </div>
              </div>

              <div className="settings-form-section">
                <div className="settings-form-title-row">
                  <h3 className="settings-form-title">模型</h3>
                  <button className="btn ghost compact" onClick={fetchModels} disabled={busy !== null}>
                    {busy === 'models' ? '获取中…' : '获取模型列表'}
                  </button>
                </div>

                <div className="model-editor">
                  {draft.models.map((model, index) => (
                    <div className="model-card" key={index}>
                      <div className="model-card-head">
                        <input
                          className="model-id-input mono"
                          value={model.id}
                          onChange={event => updateModel(index, { id: event.target.value })}
                          placeholder="模型 ID，例如 deepseek-chat"
                          aria-label="Model id"
                        />
                        <input
                          className="model-name-input"
                          value={model.name ?? ''}
                          onChange={event => updateModel(index, { name: event.target.value })}
                          placeholder="显示名称，例如 DeepSeek-V4.1-Flash"
                          aria-label="Model display name"
                        />
                        <button
                          className="icon-btn subtle"
                          onClick={() => removeModel(index)}
                          aria-label={`删除模型 ${model.id || index + 1}`}
                        >
                          <CloseIcon size={13} />
                        </button>
                      </div>
                      <div className="model-card-row">
                        <label className="model-mini-field">
                          <span>上下文窗口</span>
                          <TokenAmountInput
                            value={model.contextWindow}
                            onChange={contextWindow => updateModel(index, { contextWindow })}
                            ariaLabel="上下文窗口"
                          />
                        </label>
                        <label className="model-mini-field">
                          <span>最大输出 token</span>
                          <TokenAmountInput
                            value={model.maxOutputTokens}
                            onChange={maxOutputTokens => updateModel(index, { maxOutputTokens })}
                            ariaLabel="最大输出 token"
                          />
                        </label>
                      </div>
                      <div className="model-types">
                        <span>输入类型</span>
                        {(['text', 'image'] as const).map(type => (
                          <label key={type}>
                            <input
                              type="checkbox"
                              checked={(model.inputTypes ?? ['text']).includes(type)}
                              onChange={(event) => {
                                const current = model.inputTypes ?? ['text']
                                const next = event.target.checked
                                  ? [...new Set([...current, type])]
                                  : current.filter(item => item !== type)
                                updateModel(index, { inputTypes: next })
                              }}
                            />
                            {type === 'image' ? '图片' : '文本'}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <button className="btn ghost model-add" onClick={addModel}>
                    <PlusIcon size={14} />
                    添加模型
                  </button>
                </div>

                <p className="field-help">
                  “获取模型列表”会请求 <code>{draft.baseUrl.replace(/\/+$/, '')}/models</code>。
                  上下文窗口用于右上角占用比例；输入类型决定该模型能否接收图片附件。
                </p>
              </div>

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
  )
}
