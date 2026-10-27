import { useEffect, useState } from 'react'
import { api, type RuntimeInfo } from '../../api.ts'
import { SearchIcon } from '../Icons.tsx'
import { SettingsGroup, SettingsScroll } from './SettingsLayout.tsx'

function runtimeState(state: string) {
  if (state === 'ACTIVE') return 'ok'
  if (state === 'PENDING' || state === 'LOADING') return 'warn'
  if (state === 'FAILED') return 'danger'
  return 'off'
}

export function PluginsSettings() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
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
  }, [])

  const toggle = async (entryId: string, enabled: boolean) => {
    setBusy(entryId)
    try {
      setRuntime(await api.setPluginEnabled(entryId, enabled))
      setRuntimeError(null)
    } catch (caught) {
      setRuntimeError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const term = query.trim().toLowerCase()
  const plugins = (runtime?.plugins ?? [])
    .filter(plugin => Boolean(plugin.title))
    .filter((plugin) => {
      if (!term) return true
      return plugin.id.toLowerCase().includes(term)
        || plugin.name.toLowerCase().includes(term)
        || (plugin.title ?? '').toLowerCase().includes(term)
        || (plugin.description ?? '').toLowerCase().includes(term)
    })
  // Disabled entries are listed by package name (`@ruobai/mode-plan`), not by
  // the fiber name the rest of the list uses.
  const sessionPlugins = plugins.filter(plugin => plugin.name.includes('mode-'))
  const globalPlugins = plugins.filter(plugin => !plugin.name.includes('mode-'))

  return (
    <SettingsScroll className="plugins-page">
      <div className="plugin-search">
        <SearchIcon size={14} />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索插件"
          aria-label="搜索插件"
        />
        {query
          ? <button onClick={() => setQuery('')} aria-label="清除插件搜索">×</button>
          : null}
      </div>
      <p className="settings-section-note">开关作用于当前进程，重启后按 cordis.yml 恢复。</p>

      {runtimeError ? <div className="detail-note error">{runtimeError}</div> : null}

      {runtime
        ? (
          <>
            {sessionPlugins.length
              ? (
                <SettingsGroup label="会话插件">
                  {sessionPlugins.map(plugin => (
                    <PluginRow
                      key={`${plugin.name}-${plugin.uid ?? plugin.entryId}`}
                      plugin={plugin}
                      busy={busy === plugin.entryId}
                      onToggle={toggle}
                    />
                  ))}
                </SettingsGroup>
              )
              : null}

            <SettingsGroup label="全局插件">
              {globalPlugins.map(plugin => (
                <PluginRow
                  key={`${plugin.name}-${plugin.uid ?? plugin.entryId}`}
                  plugin={plugin}
                  busy={busy === plugin.entryId}
                  onToggle={toggle}
                />
              ))}
            </SettingsGroup>

            {plugins.length ? null : <div className="detail-note">没有匹配的插件。</div>}
          </>
        )
        : <div className="loading">loading plugins…</div>}
    </SettingsScroll>
  )
}

function PluginRow({ plugin, busy, onToggle }: {
  plugin: RuntimeInfo['plugins'][number]
  busy: boolean
  onToggle: (entryId: string, enabled: boolean) => void
}) {
  const title = plugin.title || plugin.name
  const description = plugin.description || ''
  return (
    <article className={`plugin-row ${plugin.enabled ? '' : 'off'}`}>
      <div className="plugin-row-copy">
        <div className="plugin-row-head">
          <span className={`status-dot ${runtimeState(plugin.state)}`} />
          <span className="plugin-row-name">{title}</span>
          <span className={`state state-${runtimeState(plugin.state)}`}>{plugin.state.toLowerCase()}</span>
          {plugin.enabled ? null : <span className="plugin-row-tag">已停用</span>}
        </div>
        {description ? <p className="plugin-row-desc">{description}</p> : null}
        <div className="plugin-row-meta">
          <code>{plugin.id}</code>
          {plugin.services.length ? <span>{plugin.services.join(', ')}</span> : null}
        </div>
      </div>
      {plugin.toggleable && plugin.entryId
        ? (
          <button
            type="button"
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`${plugin.enabled ? '停用' : '启用'} ${title}`}
            className={`plugin-switch ${plugin.enabled ? 'on' : ''}`}
            disabled={busy}
            onClick={() => onToggle(plugin.entryId!, !plugin.enabled)}
          >
            <span />
          </button>
        )
        : null}
    </article>
  )
}
