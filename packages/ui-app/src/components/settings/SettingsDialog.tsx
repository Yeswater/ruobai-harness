import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEscapeKey } from '../../useEscapeKey.ts'
import { api, type PublicSettings, type ThemePreference } from '../../api.ts'
import type { CollapsedSidebar, UiSkin } from '../../preferences.ts'
import {
  BotIcon, BrainIcon, CheckIcon, CloseIcon, CommandIcon, FolderTreeIcon, GlobeIcon, MonitorIcon, PlugIcon, PuzzleIcon, SearchIcon, ShieldIcon, SlidersIcon,
} from '../Icons.tsx'
import { PermissionsSettings } from '../PermissionsSettings.tsx'
import { SkillDraftsSettings } from './SkillDraftsSettings.tsx'
import { ProtocolsSettings } from '../ProtocolsSettings.tsx'
import { Slot } from '../Slot.tsx'
import { GeneralSettings } from './GeneralSettings.tsx'
import { NetworkSettings } from './NetworkSettings.tsx'
import { PluginsSettings } from './PluginsSettings.tsx'
import { ProvidersSettings } from './ProvidersSettings.tsx'
import { WikiSettings } from './WikiSettings.tsx'
import { IconButton, Toast, type SaveState } from '../ui/index.tsx'

interface SettingsDialogProps {
  open: boolean
  initialTab?: SettingsTab
  sessionId?: string
  themePreference: ThemePreference
  onThemeChange: (value: ThemePreference) => void
  skin: UiSkin
  onSkinChange: (skin: UiSkin) => void
  showBrand: boolean
  onShowBrandChange: (show: boolean) => void
  collapsedMode: CollapsedSidebar
  onCollapsedModeChange: (mode: CollapsedSidebar) => void
  onClose: () => void
  onSaved?: () => void
}

export type SettingsTab = 'providers' | 'permissions' | 'behavior' | 'runtime' | 'network' | 'sandbox' | 'protocols' | 'hooks' | 'gitee' | 'memory' | 'wiki' | 'skills'

interface NavItem {
  id: SettingsTab
  label: string
  description: string
  icon: ReactNode
  keywords?: string
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '设置',
    items: [
      {
        id: 'behavior',
        label: '通用',
        description: '外观、默认模式、权限与上下文压缩。',
        icon: <SlidersIcon size={15} />,
        keywords: '模式 权限 主题 外观 深色 浅色 前缀 上下文 压缩 命令 皮肤 主题皮肤',
      },
      {
        id: 'providers',
        label: '模型',
        description: '管理模型供应商、密钥与默认模型。',
        icon: <BotIcon size={15} />,
        keywords: '供应商 模型 密钥 地址 上下文窗口 输入类型 API',
      },
      {
        id: 'protocols',
        label: '协议',
        description: 'AGENTS、MCP 配置与 A2A 远端智能体的加载情况。',
        icon: <CommandIcon size={15} />,
        keywords: 'AGENTS mcp a2a .ruobai 指令 配置',
      },
      {
        id: 'permissions',
        label: '权限',
        description: '审批规则、内置危险命令保护与审批模式。',
        icon: <ShieldIcon size={15} />,
        keywords: '审批 规则 危险命令 允许 询问 拒绝',
      },
      {
        id: 'hooks',
        label: '门禁',
        description: '提交前自动运行检查，阻断不合格的改动。',
        icon: <CheckIcon size={15} />,
        keywords: 'hook lint 检查 门禁 格式化 阻断 审计 biome',
      },
      {
        id: 'memory',
        label: '长期记忆',
        description: '长期偏好、约束与决策。',
        icon: <BrainIcon size={15} />,
        keywords: '记忆 remember 偏好 约束 决策 遗忘 固定',
      },
      {
        id: 'wiki',
        label: '知识库',
        description: '自动检索与空闲提案。',
        icon: <FolderTreeIcon size={15} />,
        keywords: '知识库 wiki 自动检索 提案 召回 recall 提案 distill',
      },
      {
        id: 'skills',
        label: '技能',
        description: '会话沉淀的技能草稿，批准后进入项目技能。',
        icon: <PuzzleIcon size={15} />,
        keywords: '技能 skill 草稿 沉淀 批准 SKILL.md',
      },
    ],
  },
  {
    label: '这台电脑',
    items: [
      {
        id: 'sandbox',
        label: '沙箱',
        description: '本机沙箱策略、拒绝记录与豁免。',
        icon: <MonitorIcon size={15} />,
        keywords: '沙箱 守卫 拒绝 升级 seatbelt 审批',
      },
      {
        id: 'network',
        label: '网络',
        description: '代理开关、系统代理检测与外发连接测试。',
        icon: <GlobeIcon size={15} />,
        keywords: '网络 代理 proxy 端口 系统代理 7890 直连 测试 连接',
      },
      {
        id: 'gitee',
        label: 'Gitee',
        description: 'Gitee 账号、仓库与发布。',
        icon: <PlugIcon size={15} />,
        keywords: 'gitee 仓库 发布 release issue pr 令牌 token',
      },
      {
        id: 'runtime',
        label: '内置插件',
        description: '内置插件的运行状态与开关。',
        icon: <PuzzleIcon size={15} />,
        keywords: '插件 服务 地址 启用 停用',
      },
    ],
  },
]

const NAV_ITEMS = NAV_GROUPS.flatMap(group => group.items)

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
}

function matchesItem(item: NavItem, term: string) {
  if (!term) return true
  return item.label.toLowerCase().includes(term)
    || item.description.toLowerCase().includes(term)
    || Boolean(item.keywords?.toLowerCase().includes(term))
}

export function SettingsDialog({
  open, initialTab, sessionId, themePreference, onThemeChange, skin, onSkinChange,
  showBrand, onShowBrandChange, collapsedMode, onCollapsedModeChange, onClose, onSaved,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>('behavior')
  const [query, setQuery] = useState('')
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Autosave feedback floats over the header; it disappears on its own so it
  // never takes space or lingers across pages. Errors keep their inline notice.
  useEffect(() => {
    if (saveState !== 'saved' && saveState !== 'error') return
    const timer = window.setTimeout(() => setSaveState('idle'), 2400)
    return () => window.clearTimeout(timer)
  }, [saveState])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setTab(initialTab ?? 'behavior')
    setQuery('')
    setLoadError(null)
    setSettings(null)
    void api.getSettings()
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch((caught) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [open, initialTab])

  // Each tab is a page, not a scroll position: start it at the top and drop
  // the previous page's save hint.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
    setSaveState('idle')
  }, [tab])

  // Esc leaves settings; a nested dropdown consumes the first press instead.
  useEscapeKey(onClose, open)

  if (!open) return null

  const active = NAV_ITEMS.find(item => item.id === tab) ?? NAV_ITEMS[0]!
  const term = query.trim().toLowerCase()
  const matchedGroups = NAV_GROUPS
    .map(group => ({ ...group, items: group.items.filter(item => matchesItem(item, term)) }))
    .filter(group => group.items.length)
  const providers = settings?.llm?.providers ?? []
  const activeProvider = settings?.llm?.activeProvider ?? ''
  const activeEntry = providers.find(provider => provider.id === activeProvider)
  const activeModel = activeEntry ? settings?.llm?.activeModel ?? '' : ''
  const activeProviderName = activeEntry?.name ?? '未配置模型'

  const handleSettingsChange = (next: PublicSettings) => {
    setSettings(next)
    onSaved?.()
  }

  const flush = tab === 'providers' || tab === 'permissions'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <div className="settings-shell">
          <aside className="settings-nav">
            <div className="settings-nav-head">
              <span className="settings-nav-title">设置</span>
            </div>

            <div className="settings-search">
              <SearchIcon size={14} />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索设置"
                aria-label="搜索设置"
              />
              {query
                ? <button onClick={() => setQuery('')} aria-label="清除搜索">×</button>
                : null}
            </div>

            <nav className="settings-nav-groups" role="tablist" aria-orientation="vertical" aria-label="设置分类">
              {matchedGroups.map(group => (
                <div className="settings-nav-group" key={group.label}>
                  <div className="settings-nav-label">{group.label}</div>
                  {group.items.map(item => (
                    <button
                      key={item.id}
                      id={`settings-tab-${item.id}`}
                      className={`settings-nav-item ${tab === item.id ? 'active' : ''}`}
                      onClick={() => setTab(item.id)}
                      role="tab"
                      aria-selected={tab === item.id}
                      aria-controls="settings-tabpanel"
                    >
                      <span className="settings-nav-icon">{item.icon}</span>
                      <span className="settings-nav-text">{item.label}</span>
                    </button>
                  ))}
                </div>
              ))}
              {matchedGroups.length ? null : <div className="settings-nav-empty">没有匹配的设置</div>}
            </nav>
          </aside>

          <section
            className="settings-content"
            id="settings-tabpanel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
          >
            <header className="settings-page-head">
              <div className="settings-page-heading">
                <h2>{active.label}</h2>
                <p className="settings-page-sub">{active.description}</p>
              </div>
              <div className="settings-page-actions">
                {saveState !== 'idle'
                  ? (
                    <span className="settings-save-slot">
                      <Toast tone={saveState === 'saved' ? 'ok' : saveState === 'error' ? 'error' : 'neutral'}>
                        {SAVE_LABEL[saveState]}
                      </Toast>
                    </span>
                  )
                  : null}
                {tab === 'providers'
                  ? (
                    <div className="settings-page-current">
                      当前默认
                      <strong>{activeProviderName}</strong>
                      {activeModel ? <span>{activeModel}</span> : null}
                    </div>
                  )
                  : null}
                <IconButton className="settings-close" onClick={onClose} aria-label="关闭设置" title="关闭设置 (Esc)">
                  <CloseIcon />
                </IconButton>
              </div>
            </header>

            {loadError ? <div className="ui-notice error settings-load-error">{loadError}</div> : null}

            <div className={flush ? 'settings-page-body flush' : 'settings-page-body'} ref={bodyRef}>
              {tab === 'behavior'
                ? (
                  <GeneralSettings
                    settings={settings}
                    themePreference={themePreference}
                    onThemeChange={onThemeChange}
                    skin={skin}
                    onSkinChange={onSkinChange}
                    showBrand={showBrand}
                    onShowBrandChange={onShowBrandChange}
                    collapsedMode={collapsedMode}
                    onCollapsedModeChange={onCollapsedModeChange}
                    onSaved={handleSettingsChange}
                    onSaveState={setSaveState}
                  />
                )
                : tab === 'providers'
                  ? (
                    <ProvidersSettings
                      settings={settings}
                      onSettingsChange={handleSettingsChange}
                    />
                  )
                  : tab === 'runtime'
                    ? <PluginsSettings />
                    : tab === 'protocols'
                      ? <ProtocolsSettings sessionId={sessionId} />
                      : tab === 'network'
                        ? (
                          <NetworkSettings
                            settings={settings}
                            onSettingsChange={handleSettingsChange}
                            onSaveState={setSaveState}
                          />
                        )
                        : tab === 'permissions'
                        ? <PermissionsSettings />
                        : tab === 'memory'
                          ? <div className="settings-slot"><Slot name="settings.memory" props={{ sessionId }} /></div>
                          : tab === 'wiki'
                            ? <WikiSettings />
                            : tab === 'skills'
                              ? (
                                <>
                                  <SkillDraftsSettings />
                                  <div className="settings-slot"><Slot name="settings.eval" props={{ sessionId }} /></div>
                                </>
                              )
                              : tab === 'sandbox'
                                ? <div className="settings-slot"><Slot name="settings.sandbox" props={{ sessionId }} /></div>
                                : tab === 'hooks'
                                  ? (
                                    <>
                                      <div className="settings-slot"><Slot name="settings.hooks" props={{ sessionId }} /></div>
                                      <div className="settings-slot"><Slot name="settings.rubric" props={{ sessionId }} /></div>
                                    </>
                                  )
                                  : <div className="settings-slot"><Slot name="settings.gitee" props={{ sessionId }} /></div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
