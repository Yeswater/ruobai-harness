import { useEffect, useState, type ReactNode } from 'react'
import { useEscapeKey } from '../useEscapeKey.ts'
import { api, type CommandPrefix, type ModeInfo, type PermissionMode, type ProviderMode, type ProviderModel, type PublicProvider, type PublicSettings, type RuntimeInfo, type ThemePreference } from '../api.ts'
import {
  BotIcon, CloseIcon, CommandIcon, MonitorIcon, MoonIcon, PlugIcon, PlusIcon, PuzzleIcon, SearchIcon, ShieldIcon, SlidersIcon, SunIcon,
} from './Icons.tsx'
import { McpSettings } from './McpSettings.tsx'
import { PERMISSION_OPTIONS } from './PermissionSelect.tsx'
import { PermissionsSettings } from './PermissionsSettings.tsx'
import { ProtocolsSettings } from './ProtocolsSettings.tsx'
import { Select } from './Select.tsx'
import { Slot } from './Slot.tsx'
import { TokenAmountInput } from './TokenAmountInput.tsx'

interface SettingsDialogProps {
  open: boolean
  initialTab?: SettingsTab
  sessionId?: string
  themePreference: ThemePreference
  onThemeChange: (value: ThemePreference) => void
  onClose: () => void
  onSaved?: () => void
}

export type SettingsTab = 'providers' | 'mcp' | 'permissions' | 'behavior' | 'runtime' | 'sandbox' | 'protocols'

const NAV_GROUPS: Array<{
  label: string
  items: Array<{ id: SettingsTab; label: string; icon: ReactNode; keywords?: string }>
}> = [
  {
    label: '设置',
    items: [
      { id: 'behavior', label: '通用', icon: <SlidersIcon size={15} />, keywords: '模式 权限 主题 外观 前缀 上下文 压缩 命令' },
      { id: 'providers', label: '模型', icon: <BotIcon size={15} />, keywords: '供应商 模型 密钥 地址 上下文窗口 输入类型' },
      { id: 'mcp', label: 'MCP 连接器', icon: <PlugIcon size={15} />, keywords: '服务器 工具 连接' },
      { id: 'protocols', label: '协议', icon: <CommandIcon size={15} />, keywords: 'AGENTS skill 技能 mcp a2a .ruobai 指令' },
      { id: 'permissions', label: '权限', icon: <ShieldIcon size={15} />, keywords: '审批 规则 危险命令' },
    ],
  },
  {
    label: '这台电脑',
    items: [
      { id: 'sandbox', label: '沙箱', icon: <MonitorIcon size={15} />, keywords: '沙箱 守卫 拒绝 升级 seatbelt 审批' },
      { id: 'runtime', label: '内置插件', icon: <PuzzleIcon size={15} />, keywords: '插件 服务 地址' },
    ],
  },
]

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

export function SettingsDialog({
  open, initialTab, sessionId, themePreference, onThemeChange, onClose, onSaved,
}: SettingsDialogProps) {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [defaultModel, setDefaultModel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<SettingsTab>('behavior')
  const [settingQuery, setSettingQuery] = useState('')
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [agentMode, setAgentMode] = useState('agent')
  const [defaultPermission, setDefaultPermission] = useState<PermissionMode>('workspace-write')
  const [commandPrefix, setCommandPrefix] = useState<CommandPrefix>('～')
  const [compactPercent, setCompactPercent] = useState(80)
  const [pluginQuery, setPluginQuery] = useState('')

  const providers = settings?.llm?.providers ?? []
  const activeProvider = settings?.llm?.activeProvider ?? 'mock'
  const activeModel = settings?.llm?.activeModel ?? ''
  const selected = providers.find(provider => provider.id === selectedId)

  const load = async (selectId?: string) => {
    const next = await api.getSettings()
    setSettings(next)
    setAgentMode(next.agent?.defaultMode ?? 'agent')
    setDefaultPermission(next.agent?.defaultPermission ?? 'workspace-write')
    setCommandPrefix(next.agent?.commandPrefix ?? '～')
    setCompactPercent(next.agent?.compactPercent ?? 80)
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
    setSettingQuery('')
    setTab(initialTab ?? 'behavior')
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
  }, [open, initialTab])

  // Esc leaves settings; a nested dropdown consumes the first press instead.
  useEscapeKey(onClose, open)

  useEffect(() => {
    if (!open || tab !== 'runtime') return
    let cancelled = false
    const load = async () => {
      try {
        const info = await api.getRuntime()
        if (!cancelled) {
          setRuntime(info)
          setRuntimeError(null)
        }
      } catch (caught) {
        if (!cancelled) setRuntimeError(caught instanceof Error ? caught.message : String(caught))
      }
    }
    void load()
    const timer = setInterval(load, 3_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [open, tab])

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
      const input = {
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
          defaultPermission,
          commandPrefix,
          compactPercent: Number(compactPercent) || 80,
        },
      })
      setSettings(next)
      setNotice('已保存。默认模式、默认权限与命令前缀已更新。')
      onSaved?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const term = settingQuery.trim().toLowerCase()
  const matchedGroups = NAV_GROUPS
    .map(group => ({
      ...group,
      items: group.items.filter(item =>
        !term
        || item.label.toLowerCase().includes(term)
        || item.keywords?.toLowerCase().includes(term)),
    }))
    .filter(group => group.items.length)
  const currentLabel = NAV_GROUPS
    .flatMap(group => group.items)
    .find(item => item.id === tab)?.label ?? '设置'

  const pluginTerm = pluginQuery.trim().toLowerCase()
  const pluginList = (runtime?.plugins ?? [])
    .filter(plugin => Boolean(plugin.title))
    .filter((plugin) => {
      if (!pluginTerm) return true
      return plugin.id.toLowerCase().includes(pluginTerm)
        || plugin.name.toLowerCase().includes(pluginTerm)
        || (plugin.title ?? '').toLowerCase().includes(pluginTerm)
        || (plugin.description ?? '').toLowerCase().includes(pluginTerm)
    })
  const sessionPlugins = pluginList.filter(plugin => plugin.name.startsWith('mode-'))
  const globalPlugins = pluginList.filter(plugin => !plugin.name.startsWith('mode-'))

  const selectTab = (next: SettingsTab) => {
    setTab(next)
    setError(null)
    setNotice(null)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <button
          className="icon-btn settings-close"
          onClick={onClose}
          aria-label="关闭设置"
          title="关闭设置 (Esc)"
        >
          <CloseIcon />
        </button>

        <div className="settings-shell">
          <aside className="settings-nav">
            <div className="settings-search">
              <SearchIcon size={14} />
              <input
                value={settingQuery}
                onChange={event => setSettingQuery(event.target.value)}
                placeholder="搜索设置"
                aria-label="搜索设置"
              />
              {settingQuery
                ? <button onClick={() => setSettingQuery('')} aria-label="清除搜索">×</button>
                : null}
            </div>

            {matchedGroups.map(group => (
              <div className="settings-nav-group" key={group.label}>
                <div className="settings-nav-label">{group.label}</div>
                {group.items.map(item => (
                  <button
                    key={item.id}
                    className={`settings-nav-item ${tab === item.id ? 'active' : ''}`}
                    onClick={() => selectTab(item.id)}
                  >
                    <span className="settings-nav-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
            {matchedGroups.length ? null : <div className="settings-nav-empty">没有匹配的设置</div>}
          </aside>

          <section className="settings-content">
            <header className="settings-page-head">
              <h2>{currentLabel}</h2>
              {tab === 'providers'
                ? (
                  <div className="settings-page-sub">
                    当前默认：{activeProvider === 'mock' ? 'Mock（离线）' : activeProvider}
                    {activeModel ? ` · ${activeModel}` : ''}
                  </div>
                )
                : null}
            </header>

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

                  <div className="model-head">
                    <span>模型列表</span>
                    <button className="btn ghost" onClick={fetchModels} disabled={busy !== null}>
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
            <div className="appearance-row">
              <div className="appearance-label">
                主题
                <span className="appearance-hint">跟随系统，或固定浅色 / 深色；仅保存在本机。</span>
              </div>
              <div className="theme-switch" role="group" aria-label="主题">
                <button
                  className={themePreference === 'system' ? 'active' : ''}
                  onClick={() => onThemeChange('system')}
                  aria-label="跟随系统"
                  title="跟随系统"
                >
                  <MonitorIcon size={15} />
                </button>
                <button
                  className={themePreference === 'light' ? 'active' : ''}
                  onClick={() => onThemeChange('light')}
                  aria-label="浅色"
                  title="浅色"
                >
                  <SunIcon size={15} />
                </button>
                <button
                  className={themePreference === 'dark' ? 'active' : ''}
                  onClick={() => onThemeChange('dark')}
                  aria-label="深色"
                  title="深色"
                >
                  <MoonIcon size={15} />
                </button>
              </div>
            </div>

            <label className="field">
              <span>默认模式（新建会话）</span>
              <Select
                value={agentMode}
                options={modes.map(mode => ({
                  value: mode.id,
                  label: mode.name,
                  description: mode.description,
                }))}
                onChange={setAgentMode}
                ariaLabel="Default agent mode"
                menuWidth={300}
              />
            </label>

            <label className="field">
              <span>默认权限（新建会话）</span>
              <Select
                value={defaultPermission}
                options={PERMISSION_OPTIONS
                  .filter(option => option.value !== 'full-access')
                  .map(option => ({
                    value: option.value,
                    label: option.label,
                    description: option.description,
                  }))}
                onChange={value => setDefaultPermission(value as PermissionMode)}
                ariaLabel="Default permission"
                menuWidth={320}
              />
            </label>
            <p className="field-help">完全权限只能在单个会话里临时启用，不能作为全局默认。</p>

            <label className="field">
              <span>命令兼容前缀</span>
              <Select
                value={commandPrefix}
                options={[
                  { value: '～', label: '～（波浪号）', description: '默认，中文输入法下更容易输入' },
                  { value: '！', label: '！（感叹号）', description: '用感叹号触发斜杠命令' },
                  { value: '#', label: '#（井号）', description: '用井号触发斜杠命令' },
                ]}
                onChange={value => setCommandPrefix(value as CommandPrefix)}
                ariaLabel="Command prefix"
                menuWidth={320}
              />
            </label>
            <p className="field-help">/ 与 ／ 始终可用；这里选择额外的兼容触发符。</p>

            <label className="field">
              <span>上下文压缩阈值</span>
              <div className="percent-amount">
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={compactPercent}
                  onChange={event => setCompactPercent(Number(event.target.value))}
                  aria-label="上下文压缩阈值百分比"
                />
                <span>%</span>
              </div>
            </label>
            <p className="field-help">
              按当前模型上下文窗口的百分比计算；模型未配置窗口时回退到内置阈值。
            </p>

            {error ? <div className="detail-note error">{error}</div> : null}
            {notice ? <div className="detail-note">{notice}</div> : null}

            <div className="provider-actions">
              <span className="spacer" />
              <button className="btn" onClick={saveBehavior} disabled={busy !== null}>
                {busy === 'behavior' ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        ) : tab === 'mcp' ? (
          <McpSettings />
        ) : tab === 'protocols' ? (
          <ProtocolsSettings sessionId={sessionId} />
        ) : tab === 'permissions' ? (
          <PermissionsSettings />
        ) : tab === 'sandbox' ? (
          <div className="settings-page-body scroll">
            <Slot name="settings.sandbox" props={{ sessionId }} />
          </div>
        ) : (
          <div className="settings-page-body scroll plugins-page">
            <div className="plugin-search">
              <SearchIcon size={14} />
              <input
                value={pluginQuery}
                onChange={event => setPluginQuery(event.target.value)}
                placeholder="搜索插件"
                aria-label="搜索插件"
              />
              {pluginQuery
                ? <button onClick={() => setPluginQuery('')} aria-label="清除插件搜索">×</button>
                : null}
            </div>

            {runtimeError ? <div className="detail-note error">{runtimeError}</div> : null}
            {runtime
              ? (
                <>
                  {sessionPlugins.length
                    ? (
                      <>
                        <h3 className="settings-section-title">会话插件</h3>
                        <p className="settings-section-note">按会话选择的模式插件。</p>
                        <div className="plugin-cards">
                          {sessionPlugins.map(plugin => (
                            <PluginCard key={`${plugin.name}-${plugin.uid}`} plugin={plugin} />
                          ))}
                        </div>
                      </>
                    )
                    : null}

                  <h3 className="settings-section-title">全局插件</h3>
                  <p className="settings-section-note">系统与所有会话共用。</p>
                  <div className="plugin-cards">
                    {globalPlugins.map(plugin => (
                      <PluginCard key={`${plugin.name}-${plugin.uid}`} plugin={plugin} />
                    ))}
                  </div>
                  {pluginList.length ? null : <div className="detail-note">没有匹配的插件。</div>}
                </>
              )
              : <div className="loading">loading plugins…</div>}
          </div>
        )}
          </section>
        </div>
      </div>
    </div>
  )
}

function runtimeState(state: string) {
  if (state === 'ACTIVE') return 'ok'
  if (state === 'PENDING' || state === 'LOADING') return 'warn'
  if (state === 'FAILED') return 'danger'
  return 'off'
}

function PluginCard({ plugin }: { plugin: RuntimeInfo['plugins'][number] }) {
  const title = plugin.title || plugin.name
  const description = plugin.description || ''
  return (
    <article className="plugin-card">
      <header className="plugin-card-head">
        <span className={`status-dot ${runtimeState(plugin.state)}`} />
        <span className="plugin-card-name">{title}</span>
        <span className={`state state-${runtimeState(plugin.state)}`}>{plugin.state.toLowerCase()}</span>
      </header>
      {description ? <p className="plugin-card-desc">{description}</p> : null}
      <div className="plugin-card-meta">
        <code className="plugin-card-id">{plugin.id}</code>
        {plugin.services.length
          ? <span className="plugin-card-services">{plugin.services.join(', ')}</span>
          : null}
      </div>
    </article>
  )
}
