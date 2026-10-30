import { useEffect, useState } from 'react'
import {
  api,
  type NetworkCheck,
  type NetworkSettings as NetworkConfig,
  type NetworkStatus,
  type PublicSettings,
} from '../../api.ts'
import { RefreshIcon } from '../Icons.tsx'
import { Button, Notice, Switch, useAutosave, type SaveState } from '../ui/index.tsx'
import { SettingRow, SettingsGroup } from './SettingsLayout.tsx'

interface NetworkSettingsProps {
  settings: PublicSettings | null
  onSettingsChange: (settings: PublicSettings) => void
  onSaveState?: (state: SaveState) => void
}

interface Draft {
  enabled: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
}

const SOURCE_LABEL: Record<NetworkStatus['detected']['source'], string> = {
  scutil: 'macOS 系统代理',
  environment: '代理环境变量',
  none: '未检测到',
}

const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,.local'

function draftOf(network?: NetworkConfig): Draft {
  return {
    enabled: network?.enabled === true,
    httpProxy: network?.httpProxy ?? '',
    httpsProxy: network?.httpsProxy ?? '',
    noProxy: network?.noProxy ?? '',
  }
}

export function NetworkSettings({ settings, onSettingsChange, onSaveState }: NetworkSettingsProps) {
  const saved = settings?.network
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved))
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [check, setCheck] = useState<NetworkCheck | null>(null)
  const [testing, setTesting] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const refreshStatus = async (force = true) => {
    try {
      setStatus(await api.getNetworkStatus(force))
      setStatusError(null)
    } catch (caught) {
      setStatusError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const autosave = useAutosave<Draft>(async (next) => {
    const savedSettings = await api.updateSettings({
      network: {
        enabled: next.enabled,
        httpProxy: next.httpProxy,
        httpsProxy: next.httpsProxy,
        noProxy: next.noProxy,
      },
    })
    onSettingsChange(savedSettings)
    await refreshStatus()
  })

  useEffect(() => {
    void refreshStatus(false)
  }, [])

  useEffect(() => {
    if (autosave.state === 'dirty' || autosave.state === 'saving') return
    setDraft(draftOf(saved))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  useEffect(() => {
    onSaveState?.(autosave.state)
    return () => onSaveState?.('idle')
  }, [autosave.state, onSaveState])

  const update = (partial: Partial<Draft>) => {
    const next = { ...draft, ...partial }
    setDraft(next)
    setCheck(null)
    autosave.schedule(next)
  }

  const restoreSystem = () => update({ httpProxy: '', httpsProxy: '', noProxy: '' })

  const test = async () => {
    setTesting(true)
    setCheck(null)
    try {
      setCheck(await api.testNetwork())
    } catch (caught) {
      setCheck({
        ok: false,
        viaProxy: Boolean(status?.effective.http ?? status?.effective.https),
        error: caught instanceof Error ? caught.message : String(caught),
      })
    } finally {
      setTesting(false)
    }
  }

  const detected = status?.detected
  const effective = status?.effective
  const hasOverrides = Boolean(draft.httpProxy || draft.httpsProxy || draft.noProxy)
  const shownError = statusError ?? status?.error

  return (
    <div className="settings-panel">
      <SettingsGroup label="代理">
        <SettingRow
          title="启用代理"
          description="模型请求、命令与 git 子进程都走这里；本地地址始终直连。"
        >
          <Switch
            checked={draft.enabled}
            label="启用代理"
            onChange={enabled => update({ enabled })}
          />
        </SettingRow>

        <div className="setting-row stacked">
          <div className="setting-row-copy">
            <div className="setting-row-title">应用级代理</div>
            <div className="setting-row-desc">
              留空即继承系统值；填写后覆盖系统值。应用级在 RuoBai 内优先。
            </div>
          </div>
          <div className="setting-row-control network-vars">
            <label className="ui-field">
              <span className="ui-label">HTTP_PROXY</span>
              <input
                className="ui-input"
                value={draft.httpProxy}
                onChange={event => update({ httpProxy: event.target.value })}
                placeholder={detected?.http ?? '未检测到系统值'}
                aria-label="HTTP_PROXY"
                spellCheck={false}
              />
            </label>
            <label className="ui-field">
              <span className="ui-label">HTTPS_PROXY</span>
              <input
                className="ui-input"
                value={draft.httpsProxy}
                onChange={event => update({ httpsProxy: event.target.value })}
                placeholder={detected?.https ?? detected?.http ?? '未检测到系统值'}
                aria-label="HTTPS_PROXY"
                spellCheck={false}
              />
            </label>
            <label className="ui-field">
              <span className="ui-label">NO_PROXY</span>
              <input
                className="ui-input"
                value={draft.noProxy}
                onChange={event => update({ noProxy: event.target.value })}
                placeholder={detected?.noProxy ?? DEFAULT_NO_PROXY}
                aria-label="NO_PROXY"
                spellCheck={false}
              />
            </label>
            <div className="network-vars-actions">
              <Button variant="ghost" small onClick={restoreSystem} disabled={!hasOverrides}>
                恢复系统默认
              </Button>
            </div>
          </div>
        </div>

        <SettingRow
          title="系统代理"
          description={`来源：${SOURCE_LABEL[detected?.source ?? 'none']}。修改系统代理后点「重新检测」。`}
        >
          <div className="network-detect">
            <span className="network-value mono">
              {detected?.https ?? detected?.http ?? detected?.socks ?? detected?.detail ?? '未检测到'}
            </span>
            <Button variant="ghost" small onClick={() => void refreshStatus(true)}>
              <RefreshIcon size={13} />
              重新检测
            </Button>
          </div>
        </SettingRow>

        <SettingRow title="当前生效" description="请求与子进程实际拿到的值。">
          <div className="network-effective mono">
            <span>HTTP · {effective?.http ?? '直连'}</span>
            <span>HTTPS · {effective?.https ?? '直连'}</span>
            <span>NO_PROXY · {effective?.noProxy ?? DEFAULT_NO_PROXY}</span>
          </div>
        </SettingRow>
      </SettingsGroup>

      {shownError ? <Notice tone="error">{shownError}</Notice> : null}

      <SettingsGroup label="连通性">
        <SettingRow
          title="测试连接"
          description="请求当前供应商的 /models；没有供应商时请求一个通用探测地址。"
        >
          <Button onClick={() => void test()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
        </SettingRow>
        {check
          ? (
            <div className="settings-check-result">
              <Notice tone={check.ok ? 'ok' : 'error'}>
                {check.ok
                  ? `连接正常 · HTTP ${check.status} · ${check.latencyMs}ms · ${check.viaProxy ? `经 ${check.proxy}` : '直连'}`
                  : `连接失败：${check.error ?? '未知错误'}${check.viaProxy ? `（经 ${check.proxy}）` : ''}`}
              </Notice>
            </div>
          )
          : null}
      </SettingsGroup>

      <p className="settings-section-note">
        本地地址（localhost、127.0.0.1、*.local）始终直连。命令与 git 子进程会继承 HTTP_PROXY /
        HTTPS_PROXY / NO_PROXY；SOCKS 代理不受支持，请填写 HTTP 代理端口。
      </p>
    </div>
  )
}
