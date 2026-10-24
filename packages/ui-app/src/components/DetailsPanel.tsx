import { useEffect, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type RuntimeInfo } from '../api.ts'
import { FileBrowser } from './FileBrowser.tsx'
import { CloseIcon } from './Icons.tsx'
import { Slot } from './Slot.tsx'

interface DetailsPanelProps {
  session: ChatSession | null
  onClose: () => void
}

type Tab = 'session' | 'files' | 'runtime'

export function DetailsPanel({ session, onClose }: DetailsPanelProps) {
  const [tab, setTab] = useState<Tab>('session')
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)

  useEffect(() => {
    if (tab !== 'runtime') return
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
  }, [tab])

  return (
    <aside className="details">
      <div className="details-head">
        <div className="tabs">
          <button className={`tab ${tab === 'session' ? 'active' : ''}`} onClick={() => setTab('session')}>Session</button>
          <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>Files</button>
          <button className={`tab ${tab === 'runtime' ? 'active' : ''}`} onClick={() => setTab('runtime')}>Runtime</button>
        </div>
        <button className="icon-btn subtle" onClick={onClose} aria-label="Close details"><CloseIcon /></button>
      </div>

      {tab === 'session'
        ? (
          <div className="details-body">
            {session
              ? (
                <>
                  <div className="detail-title">{session.title}</div>
                  <dl className="kv">
                    <dt>status</dt><dd>{session.streaming ? 'streaming' : 'idle'}</dd>
                    <dt>model</dt><dd>{session.model}</dd>
                    <dt>messages</dt><dd>{session.messages.length}</dd>
                    <dt>created</dt><dd>{new Date(session.createdAt).toLocaleString()}</dd>
                    <dt>updated</dt><dd>{new Date(session.updatedAt).toLocaleString()}</dd>
                    <dt>id</dt><dd className="mono ellipsis">{session.id}</dd>
                  </dl>
                  <div className="detail-note">
                    会话以事件日志形式保存在服务端，JSONL 落盘后重启可恢复。
                  </div>
                  <Slot name="details.side" />
                </>
              )
              : <div className="loading">no session</div>}
          </div>
        )
        : tab === 'files'
          ? (
            <div className="details-body files-body">
              <FileBrowser />
            </div>
          )
          : (
            <div className="details-body">
              {runtimeError ? <div className="detail-note error">{runtimeError}</div> : null}
              {runtime
                ? (
                  <>
                    <div className="detail-section">Server</div>
                    <div className="mono small">{runtime.url}</div>
                    <div className="detail-section">Plugins</div>
                    <div className="plugin-list">
                      {runtime.plugins.map(plugin => (
                        <div className="plugin" key={`${plugin.name}-${plugin.uid}`}>
                          <span className={`status-dot ${stateClass(plugin.state)}`} />
                          <span className="plugin-name">{plugin.name}</span>
                          <span className={`state state-${stateClass(plugin.state)}`}>{plugin.state.toLowerCase()}</span>
                          {plugin.services.length ? <span className="plugin-services">{plugin.services.join(', ')}</span> : null}
                        </div>
                      ))}
                    </div>
                    <div className="detail-section">Services</div>
                    <div className="chip-row">
                      {runtime.services.map(service => <span className="chip" key={service}>{service}</span>)}
                    </div>
                  </>
                )
                : <div className="loading">loading runtime…</div>}
            </div>
          )}
    </aside>
  )
}

function stateClass(state: string) {
  if (state === 'ACTIVE') return 'ok'
  if (state === 'PENDING' || state === 'LOADING') return 'warn'
  if (state === 'FAILED') return 'danger'
  return 'off'
}
