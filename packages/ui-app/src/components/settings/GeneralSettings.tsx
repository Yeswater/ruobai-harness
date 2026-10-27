import { useEffect, useState } from 'react'
import {
  api,
  type CommandPrefix,
  type ModeInfo,
  type PermissionMode,
  type PublicSettings,
  type ThemePreference,
} from '../../api.ts'
import { MonitorIcon, MoonIcon, AlertIcon, SunIcon } from '../Icons.tsx'
import { PERMISSION_OPTIONS } from '../PermissionSelect.tsx'
import { Select } from '../Select.tsx'
import { SettingRow, SettingsGroup, SettingsScroll } from './SettingsLayout.tsx'

interface GeneralSettingsProps {
  settings: PublicSettings | null
  themePreference: ThemePreference
  onThemeChange: (value: ThemePreference) => void
  onSaved: (settings: PublicSettings) => void
}

interface AgentDefaults {
  agentMode: string
  defaultPermission: PermissionMode
  commandPrefix: CommandPrefix
  compactPercent: number
}

function defaultsOf(settings: PublicSettings | null): AgentDefaults {
  return {
    agentMode: settings?.agent?.defaultMode ?? 'agent',
    defaultPermission: settings?.agent?.defaultPermission ?? 'workspace-write',
    commandPrefix: settings?.agent?.commandPrefix ?? '～',
    compactPercent: settings?.agent?.compactPercent ?? 80,
  }
}

export function GeneralSettings({
  settings, themePreference, onThemeChange, onSaved,
}: GeneralSettingsProps) {
  const saved = defaultsOf(settings)
  const [agentMode, setAgentMode] = useState(saved.agentMode)
  const [defaultPermission, setDefaultPermission] = useState<PermissionMode>(saved.defaultPermission)
  const [commandPrefix, setCommandPrefix] = useState<CommandPrefix>(saved.commandPrefix)
  const [compactPercent, setCompactPercent] = useState(saved.compactPercent)
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)

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

  // Server settings are the source of truth; a save or an external refresh
  // rewrites the draft so the dirty state stays honest.
  useEffect(() => {
    const next = defaultsOf(settings)
    setAgentMode(next.agentMode)
    setDefaultPermission(next.defaultPermission)
    setCommandPrefix(next.commandPrefix)
    setCompactPercent(next.compactPercent)
  }, [settings])

  const dirty = agentMode !== saved.agentMode
    || defaultPermission !== saved.defaultPermission
    || commandPrefix !== saved.commandPrefix
    || compactPercent !== saved.compactPercent

  const save = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const percent = Number(compactPercent)
      const next = await api.updateSettings({
        agent: {
          defaultMode: agentMode,
          defaultPermission,
          commandPrefix,
          compactPercent: Number.isFinite(percent) ? Math.min(100, Math.max(1, Math.round(percent))) : 80,
        },
      })
      onSaved(next)
      setNotice('已保存，新建会话生效')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-panel">
      <SettingsScroll>
        <SettingsGroup label="外观">
          <SettingRow
            title="主题"
            description="跟随系统，或固定浅色 / 深色；仅保存在本机。"
          >
            <div className="theme-switch" role="group" aria-label="主题">
              <button
                className={themePreference === 'system' ? 'active' : ''}
                onClick={() => onThemeChange('system')}
                aria-label="跟随系统"
                aria-pressed={themePreference === 'system'}
                title="跟随系统"
              >
                <MonitorIcon size={15} />
              </button>
              <button
                className={themePreference === 'light' ? 'active' : ''}
                onClick={() => onThemeChange('light')}
                aria-label="浅色"
                aria-pressed={themePreference === 'light'}
                title="浅色"
              >
                <SunIcon size={15} />
              </button>
              <button
                className={themePreference === 'dark' ? 'active' : ''}
                onClick={() => onThemeChange('dark')}
                aria-label="深色"
                aria-pressed={themePreference === 'dark'}
                title="深色"
              >
                <MoonIcon size={15} />
              </button>
            </div>
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup label="新建会话">
          <SettingRow title="默认模式" description="打开新会话时使用的模式。">
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
          </SettingRow>
          <SettingRow
            title="默认权限"
            description="新建会话使用的权限；会话运行中也可以随时切换。完全权限会跳过审批，请谨慎。"
          >
            <Select
              value={defaultPermission}
              options={PERMISSION_OPTIONS.map(option => ({
                value: option.value,
                label: option.label,
                description: option.description,
              }))}
              onChange={(value) => {
                // Full access as the default is a standing decision, not a
                // one-turn convenience: ask once, on the way in.
                if (value === 'full-access') setConfirmFullAccess(true)
                else setDefaultPermission(value as PermissionMode)
              }}
              ariaLabel="Default permission"
              menuWidth={320}
            />
          </SettingRow>
          <SettingRow title="命令兼容前缀" description="/ 与 ／ 始终可用；这里选择额外的兼容触发符。">
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
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup label="上下文">
          <SettingRow
            title="压缩阈值"
            description="按当前模型上下文窗口的百分比计算；模型未配置窗口时回退到内置阈值。"
          >
            <div className="percent-amount setting-percent">
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={Number.isFinite(compactPercent) ? compactPercent : ''}
                onChange={event => setCompactPercent(Number(event.target.value))}
                aria-label="上下文压缩阈值百分比"
              />
              <span>%</span>
            </div>
          </SettingRow>
        </SettingsGroup>

        {error ? <div className="detail-note error">{error}</div> : null}
      </SettingsScroll>

      <footer className="settings-footer">
        <span className={dirty ? 'settings-footer-status dirty' : 'settings-footer-status'}>
          {dirty ? '有未保存的更改' : notice ?? '所有更改已保存'}
        </span>
        <button className="btn" onClick={save} disabled={busy || !dirty}>
          {busy ? '保存中…' : '保存'}
        </button>
      </footer>

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
                  <button className="btn ghost" onClick={() => setConfirmFullAccess(false)}>取消</button>
                  <button
                    className="btn danger-solid"
                    onClick={() => {
                      setConfirmFullAccess(false)
                      setDefaultPermission('full-access')
                    }}
                  >
                    设为默认
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
        : null}
    </div>
  )
}
