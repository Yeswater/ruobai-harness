import { useCallback, useEffect, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type ContextInfo, type GitInfo, type RuntimeInfo } from '../api.ts'
import { ChangesCard } from './ChangesCard.tsx'
import { ChangesPanel } from './ChangesPanel.tsx'
import { ContextCard } from './ContextCard.tsx'
import { EnvironmentCard } from './EnvironmentCard.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { CloseIcon } from './Icons.tsx'
import { InfoCard } from './InfoCard.tsx'
import { Slot } from './Slot.tsx'

interface DetailsPanelProps {
  session: ChatSession | null
  onClose: () => void
}

type CardKey = 'environment' | 'context' | 'changes' | 'snapshots' | 'files' | 'runtime'

export function DetailsPanel({ session, onClose }: DetailsPanelProps) {
  const [open, setOpen] = useState<Record<CardKey, boolean>>({
    environment: true,
    context: true,
    changes: true,
    snapshots: false,
    files: false,
    runtime: false,
  })
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [context, setContext] = useState<ContextInfo | null>(null)
  const [git, setGit] = useState<GitInfo | null>(null)
  const [gitError, setGitError] = useState<string | null>(null)
  const sessionId = session?.id

  const toggle = (key: CardKey) => setOpen(current => ({ ...current, [key]: !current[key] }))

  const loadGit = useCallback(async (id: string) => {
    try {
      const info = await api.getGitInfo(id)
      setGit(info)
      setGitError(null)
    } catch (caught) {
      setGitError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    if (!sessionId) {
      setGit(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const info = await api.getGitInfo(sessionId)
        if (cancelled) return
        setGit(info)
        setGitError(null)
      } catch (caught) {
        if (!cancelled) setGitError(caught instanceof Error ? caught.message : String(caught))
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])

  useEffect(() => {
    if (!open.runtime) return
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
  }, [open.runtime])

  useEffect(() => {
    if (!sessionId) {
      setContext(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const info = await api.getContext(sessionId)
        if (!cancelled) setContext(info)
      } catch {
        if (!cancelled) setContext(null)
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, session?.updatedAt])

  return (
    <aside className="details">
      <div className="details-head">
        <span className="details-title">会话</span>
        <button className="icon-btn subtle" onClick={onClose} aria-label="关闭会话栏">
          <CloseIcon />
        </button>
      </div>

      <div className="details-scroll">
        {session
          ? (
            <>
              <InfoCard title="环境" open={open.environment} onToggle={() => toggle('environment')}>
                <EnvironmentCard git={git} workspace={session.workspace} />
                {gitError ? <div className="detail-note error">{gitError}</div> : null}
              </InfoCard>

              <InfoCard title="上下文" open={open.context} onToggle={() => toggle('context')}>
                <ContextCard context={context} />
              </InfoCard>

              <InfoCard title="更改" open={open.changes} onToggle={() => toggle('changes')}>
                <ChangesCard
                  sessionId={session.id}
                  git={git}
                  onRefresh={() => { void loadGit(session.id) }}
                />
              </InfoCard>

              <InfoCard title="会话快照" open={open.snapshots} onToggle={() => toggle('snapshots')}>
                <ChangesPanel sessionId={session.id} />
              </InfoCard>

              <InfoCard title="文件" open={open.files} onToggle={() => toggle('files')} className="info-card-files">
                <FileBrowser sessionId={session.id} />
              </InfoCard>

              <InfoCard title="运行时" open={open.runtime} onToggle={() => toggle('runtime')}>
                {runtimeError ? <div className="detail-note error">{runtimeError}</div> : null}
                {runtime
                  ? (
                    <>
                      <div className="detail-section">会话</div>
                      <dl className="kv">
                        <dt>status</dt><dd>{session.streaming ? 'streaming' : 'idle'}</dd>
                        <dt>mode</dt><dd>{session.mode ?? 'agent'}</dd>
                        <dt>model</dt><dd>{session.model}</dd>
                        <dt>messages</dt><dd>{session.messages.length}</dd>
                        <dt>created</dt><dd>{new Date(session.createdAt).toLocaleString()}</dd>
                        <dt>updated</dt><dd>{new Date(session.updatedAt).toLocaleString()}</dd>
                        <dt>id</dt><dd className="mono ellipsis">{session.id}</dd>
                      </dl>
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
              </InfoCard>

              <Slot name="details.side" />
            </>
          )
          : <div className="loading">no session</div>}
      </div>
    </aside>
  )
}

function stateClass(state: string) {
  if (state === 'ACTIVE') return 'ok'
  if (state === 'PENDING' || state === 'LOADING') return 'warn'
  if (state === 'FAILED') return 'danger'
  return 'off'
}
