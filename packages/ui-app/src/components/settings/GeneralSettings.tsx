import { useEffect, useState } from 'react'
import {
  api,
  type CommandPrefix,
  type ModeInfo,
  type PermissionMode,
  type ProfileSummary,
  type PublicSettings,
  type ThemePreference,
} from '../../api.ts'
import { AlertIcon, MonitorIcon, MoonIcon, SunIcon } from '../Icons.tsx'
import { PERMISSION_OPTIONS } from '../PermissionSelect.tsx'
import { Select } from '../Select.tsx'
import { Button, Field, Notice, Segmented, Switch, useAutosave, type SaveState } from '../ui/index.tsx'
import { SKINS, type CollapsedSidebar, type UiSkin } from '../../preferences.ts'
import { useEscapeKey } from '../../useEscapeKey.ts'
import { SettingRow, SettingsGroup } from './SettingsLayout.tsx'
import { ShortcutSettings } from './ShortcutSettings.tsx'

interface GeneralSettingsProps {
  settings: PublicSettings | null
  themePreference: ThemePreference
  onThemeChange: (value: ThemePreference) => void
  skin: UiSkin
  onSkinChange: (skin: UiSkin) => void
  showBrand: boolean
  onShowBrandChange: (show: boolean) => void
  collapsedMode: CollapsedSidebar
  onCollapsedModeChange: (mode: CollapsedSidebar) => void
  onSaved: (settings: PublicSettings) => void
  onSaveState?: (state: SaveState) => void
}

interface AgentDefaults {
  agentMode: string
  defaultPermission: PermissionMode
  commandPrefix: CommandPrefix
  compactPercent: number
}

/** Stable, readable id from a label; never collides with an existing profile. */
export function uniqueProfileId(label: string, existing: ProfileSummary[]): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'env'
  let id = base
  let index = 2
  while (existing.some(profile => profile.id === id)) {
    id = `${base}-${index}`
    index += 1
  }
  return id
}

function defaultsOf(settings: PublicSettings | null): AgentDefaults {
  return {
    agentMode: settings?.agent?.defaultMode ?? 'agent',
    defaultPermission: settings?.agent?.defaultPermission ?? 'workspace-write',
    commandPrefix: settings?.agent?.commandPrefix ?? '～',
    compactPercent: settings?.agent?.compactPercent ?? 80,
  }
}

function clampPercent(value: number) {
  return Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : 80
}

const SKIN_PREVIEW: Record<UiSkin, { base: string; accent: string; panel: string }> = {
  cc: { base: '#f2f1ee', accent: '#c96442', panel: '#ffffff' },
  deepseek: { base: '#f0f3ff', accent: '#4d6bfe', panel: '#ffffff' },
}

export function GeneralSettings({
  settings, themePreference, onThemeChange, skin, onSkinChange, showBrand, onShowBrandChange,
  collapsedMode, onCollapsedModeChange, onSaved, onSaveState,
}: GeneralSettingsProps) {
  const [draft, setDraft] = useState<AgentDefaults>(() => defaultsOf(settings))
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [activeProfile, setActiveProfile] = useState(settings?.activeProfile ?? '')
  const [editing, setEditing] = useState<{ id: string; label: string; root: string } | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileNotice, setProfileNotice] = useState<string | null>(null)

  useEscapeKey(() => setEditing(null), Boolean(editing))

  const autosave = useAutosave<AgentDefaults>(async (next) => {
    const saved = await api.updateSettings({
      agent: { ...next, compactPercent: clampPercent(next.compactPercent) },
    })
    onSaved(saved)
  })

  useEffect(() => {
    let cancelled = false
    void api.getModes()
      .then(({ modes: list }) => {
        if (!cancelled) setModes(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Server settings are authoritative, but never overwrite a draft the user is
  // still editing or that has a save in flight.
  useEffect(() => {
    if (autosave.state === 'dirty' || autosave.state === 'saving') return
    setDraft(defaultsOf(settings))
    setActiveProfile(settings?.activeProfile ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  const update = (partial: Partial<AgentDefaults>) => {
    const next = { ...draft, ...partial }
    setDraft(next)
    autosave.schedule(next)
  }

  const persistProfiles = async (next: ProfileSummary[], active?: string) => {
    setProfileError(null)
    setProfileNotice(null)
    try {
      const saved = await api.updateSettings({
        profiles: next,
        ...(active !== undefined ? { activeProfile: active } : {}),
      })
      onSaved(saved)
      setProfileNotice('环境档案已保存')
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const saveProfile = async () => {
    if (!editing) return
    const label = editing.label.trim()
    if (!label) {
      setProfileError('请填写环境名称')
      return
    }
    const id = editing.id || uniqueProfileId(label, settings?.profiles ?? [])
    const root = editing.root.trim()
    const next: ProfileSummary[] = [
      ...(settings?.profiles ?? []).filter(profile => profile.id !== id),
      { id, label, ...(root ? { workspace: { root } } : {}) },
    ]
    await persistProfiles(next, settings?.activeProfile || id)
    setEditing(null)
  }

  const removeProfile = async (id: string) => {
    const next = (settings?.profiles ?? []).filter(profile => profile.id !== id)
    const active = settings?.activeProfile === id ? '' : settings?.activeProfile
    await persistProfiles(next, active ?? '')
  }

  useEffect(() => {
    onSaveState?.(autosave.state)
    return () => onSaveState?.('idle')
  }, [autosave.state, onSaveState])

  const profiles = settings?.profiles ?? []

  return (
    <>
      <div className="settings-panel">
        <SettingsGroup label="环境">
          <SettingRow
            title="当前环境"
            description="新建会话使用的客户/环境；切换不会移动已打开的会话。"
          >
            <Select
              value={activeProfile}
              options={[
                { value: '', label: '未选择', description: '新建会话不绑定环境' },
                ...profiles.map(profile => ({
                  value: profile.id,
                  label: profile.label,
                  description: profile.workspace?.root ?? '跟随当前工作区',
                })),
              ]}
              onChange={async (value) => {
                setActiveProfile(value)
                setProfileError(null)
                try {
                  onSaved(await api.updateSettings({ activeProfile: value }))
                  setProfileNotice('环境已切换，新建会话生效')
                } catch (caught) {
                  setProfileError(caught instanceof Error ? caught.message : String(caught))
                }
              }}
              ariaLabel="当前环境"
              menuWidth={260}
            />
          </SettingRow>

          <SettingRow
            title="环境档案"
            description="每个档案是一套客户环境；密钥只存引用名，不随档案导出。"
          >
            <Button small onClick={() => setEditing({ id: '', label: '', root: '' })}>
              新建环境
            </Button>
          </SettingRow>

          {profiles.length === 0
            ? <div className="settings-note">还没有环境档案。点「新建环境」添加一个。</div>
            : (
              <ul className="profile-list">
                {profiles.map(profile => (
                  <li key={profile.id} className="profile-row">
                    <span className="profile-label">{profile.label}</span>
                    <span className="profile-root">{profile.workspace?.root ?? '跟随当前工作区'}</span>
                    <span className="profile-row-actions">
                      <Button
                        variant="ghost"
                        small
                        onClick={() => setEditing({ id: profile.id, label: profile.label, root: profile.workspace?.root ?? '' })}
                      >
                        编辑
                      </Button>
                      <Button variant="ghost" small className="danger" onClick={() => void removeProfile(profile.id)}>
                        删除
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

          {editing
            ? null
            : profileError ? <Notice tone="error">{profileError}</Notice> : null}
          {profileNotice ? <Notice tone="ok">{profileNotice}</Notice> : null}
        </SettingsGroup>

        <SettingsGroup label="外观">
          <SettingRow
            title="主题"
            description="跟随系统，或固定浅色 / 深色；仅保存在本机。"
          >
            <Segmented
              value={themePreference}
              label="主题"
              options={[
                { value: 'system', label: <MonitorIcon size={15} />, ariaLabel: '跟随系统', title: '跟随系统' },
                { value: 'light', label: <SunIcon size={15} />, ariaLabel: '浅色', title: '浅色' },
                { value: 'dark', label: <MoonIcon size={15} />, ariaLabel: '深色', title: '深色' },
              ]}
              onChange={onThemeChange}
            />
          </SettingRow>
          <SettingRow
            title="侧栏品牌区"
            description="关闭后侧栏只保留「新会话」按钮，会话列表能多放几行。"
          >
            <Switch checked={showBrand} label="侧栏品牌区" onChange={onShowBrandChange} />
          </SettingRow>
          <SettingRow
            title="收起侧栏后"
            description="隐藏：整栏让出空间，⌘B 再展开；功能按钮：留下一条只放图标的窄栏。"
          >
            <Segmented
              value={collapsedMode}
              label="收起侧栏后"
              options={[
                { value: 'hidden', label: '隐藏' },
                { value: 'rail', label: '功能按钮' },
              ]}
              onChange={value => onCollapsedModeChange(value as CollapsedSidebar)}
            />
          </SettingRow>
          <div className="setting-row stacked">
            <div className="setting-row-copy">
              <div className="setting-row-title">界面皮肤</div>
              <div className="setting-row-desc">决定配色、圆角与密度；切换立即生效，只影响这台电脑。</div>
            </div>
            <div className="setting-row-control">
              <div className="skin-grid" role="group" aria-label="界面皮肤">
                {SKINS.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className="skin-card"
                    aria-pressed={skin === item.id}
                    onClick={() => onSkinChange(item.id)}
                  >
                    <span
                      className="skin-swatch"
                      style={{ background: SKIN_PREVIEW[item.id].base }}
                      aria-hidden="true"
                    >
                      <i style={{ background: SKIN_PREVIEW[item.id].accent }} />
                      <i style={{ background: SKIN_PREVIEW[item.id].panel }} />
                      <i style={{ background: SKIN_PREVIEW[item.id].panel }} />
                    </span>
                    <span className="skin-copy">
                      <span className="skin-name">{item.name}</span>
                      <span className="skin-note">{item.note}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </SettingsGroup>

        <SettingsGroup label="新建会话">
          <SettingRow title="默认模式" description="打开新会话时使用的模式。">
            <Select
              value={draft.agentMode}
              options={modes.map(mode => ({
                value: mode.id,
                label: mode.name,
                description: mode.description,
              }))}
              onChange={value => update({ agentMode: value })}
              ariaLabel="Default agent mode"
              menuWidth={300}
            />
          </SettingRow>
          <SettingRow
            title="默认权限"
            description="新建会话使用的权限；会话运行中也可以随时切换。完全权限会跳过审批，请谨慎。"
          >
            <Select
              value={draft.defaultPermission}
              options={PERMISSION_OPTIONS.map(option => ({
                value: option.value,
                label: option.label,
                description: option.description,
              }))}
              onChange={(value) => {
                // Full access as the default is a standing decision, not a
                // one-turn convenience: ask once, on the way in.
                if (value === 'full-access') setConfirmFullAccess(true)
                else update({ defaultPermission: value as PermissionMode })
              }}
              ariaLabel="Default permission"
              menuWidth={320}
            />
          </SettingRow>
          <SettingRow title="命令兼容前缀" description="/ 与 ／ 始终可用；这里选择额外的兼容触发符。">
            <Select
              value={draft.commandPrefix}
              options={[
                { value: '～', label: '～（波浪号）', description: '默认，中文输入法下更容易输入' },
                { value: '！', label: '！（感叹号）', description: '用感叹号触发斜杠命令' },
                { value: '#', label: '#（井号）', description: '用井号触发斜杠命令' },
              ]}
              onChange={value => update({ commandPrefix: value as CommandPrefix })}
              ariaLabel="Command prefix"
              menuWidth={320}
            />
          </SettingRow>
        </SettingsGroup>

        <ShortcutSettings />

        <SettingsGroup label="上下文">
          <SettingRow
            title="压缩阈值"
            description="按当前模型上下文窗口的百分比计算；到达阈值后自动压缩。"
          >
            <div className="percent-control">
              <input
                className="percent-range"
                type="range"
                min={50}
                max={95}
                step={5}
                value={Math.min(95, Math.max(50, clampPercent(draft.compactPercent)))}
                onChange={event => update({ compactPercent: Number(event.target.value) })}
                aria-label="上下文压缩阈值"
              />
              <span className="percent-amount setting-percent">
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={Number.isFinite(draft.compactPercent) ? draft.compactPercent : ''}
                  onChange={event => update({ compactPercent: Number(event.target.value) })}
                  aria-label="上下文压缩阈值百分比"
                />
                <span>%</span>
              </span>
            </div>
          </SettingRow>
        </SettingsGroup>

        {autosave.error ? <Notice tone="error">保存失败：{autosave.error}</Notice> : null}
      </div>

      {editing
        ? (
          <div className="modal-backdrop" onClick={() => setEditing(null)}>
            <div
              className="modal env-modal"
              role="dialog"
              aria-modal="true"
              aria-label={editing.id ? '编辑环境' : '新建环境'}
              onClick={event => event.stopPropagation()}
            >
              <div className="modal-head">
                <h2>{editing.id ? '编辑环境' : '新建环境'}</h2>
              </div>
              <div className="modal-body env-form">
                <Field label="名称">
                  <input
                    className="ui-input"
                    placeholder="例如 客户 A"
                    value={editing.label}
                    autoFocus
                    onChange={event => setEditing({ ...editing, label: event.target.value })}
                  />
                </Field>
                <Field label="工作区路径" hint="留空则跟随当前工作区。">
                  <input
                    className="ui-input"
                    placeholder="/Users/me/projects/acme"
                    value={editing.root}
                    onChange={event => setEditing({ ...editing, root: event.target.value })}
                  />
                </Field>
                {profileError ? <Notice tone="error">{profileError}</Notice> : null}
              </div>
              <div className="modal-foot">
                <span className="hint">只影响新建会话</span>
                <div className="modal-actions">
                  <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
                  <Button variant="primary" onClick={() => void saveProfile()}>保存环境</Button>
                </div>
              </div>
            </div>
          </div>
        )
        : null}

      {confirmFullAccess
        ? (
          <div className="modal-backdrop" onClick={() => setConfirmFullAccess(false)}>
            <div
              className="modal confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-label="把完全权限设为默认"
              onClick={event => event.stopPropagation()}
            >
              <div className="modal-head">
                <h2><AlertIcon size={16} /> 把完全权限设为默认</h2>
              </div>
              <div className="modal-body">
                <p className="modal-note">
                  之后新建的会话不再询问写文件、shell 命令与 MCP 调用，危险命令也不会二次确认。
                  已存在的会话保持各自的权限；审批设置里的 deny / ask 规则仍然生效。
                </p>
              </div>
              <div className="modal-foot">
                <span className="hint">只影响新建会话，保存后生效</span>
                <div className="modal-actions">
                  <Button variant="ghost" onClick={() => setConfirmFullAccess(false)}>取消</Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setConfirmFullAccess(false)
                      update({ defaultPermission: 'full-access' })
                    }}
                  >
                    设为默认
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )
        : null}
    </>
  )
}
