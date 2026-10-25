import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type ContextInfo, type GitInfo, type RuntimeInfo } from '../api.ts'
import { ContextCard } from './ContextCard.tsx'
import { EnvironmentCard } from './EnvironmentCard.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { GitPanel } from './GitPanel.tsx'
import { CloseIcon } from './Icons.tsx'
import { InfoCard } from './InfoCard.tsx'
import { Slot } from './Slot.tsx'

export type PanelView = 'session' | 'files' | 'git'

interface DetailsPanelProps {
  session: ChatSession | null
  contextInfo: ContextInfo | null
  view: PanelView
  onClose: () => void
  width: number
  onResize: (width: number) => void
  /** Insert `@path` for the given file into the composer. */
  onReferenceFile: (path: string) => void
}

const TITLES: Record<PanelView, string> = {
  session: '会话',
  files: '文件',
  git: 'Git',
}

type CardKey = 'environment' | 'context' | 'runtime'

export function DetailsPanel({
  session, contextInfo, view, width, onClose, onResize, onReferenceFile,
}: DetailsPanelProps) {
  const [open, setOpen] = useState<Record<CardKey, boolean>>({
    environment: true,
    context: true,
    runtime: false,
  })
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
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
    if (!sessionId || view === 'files') {
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
  }, [sessionId, view])

  useEffect(() => {
    if (!open.runtime || view !== 'session') return
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
  }, [open.runtime, view])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    document.body.classList.add('resizing')
    const move = (moveEvent: PointerEvent) => onResize(startWidth - (moveEvent.clientX - startX))
    const finish = () => {
      document.body.classList.remove('resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
  }

  return (
    <aside className={`details view-${view}`} style={{ width }}>
      <div
        className="details-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整详情栏宽度"
        onPointerDown={startResize}
        onDoubleClick={() => onResize(344)}
      />
      <div className="details-head">
        <span className="details-title">{TITLES[view]}</span>
        <button className="icon-btn subtle" onClick={onClose} aria-label={`关闭${TITLES[view]}栏`}>
          <CloseIcon />
        </button>
      </div>

      <div className={`details-scroll ${view === 'files' ? 'bare' : ''}`}>
        {session
          ? view === 'files'
            ? <FileBrowser sessionId={session.id} onReference={onReferenceFile} />
            : view === 'git'
              ? (
                <GitPanel
                  sessionId={session.id}
                  git={git}
                  onRefresh={() => { void loadGit(session.id) }}
                />
              )
              : (
                <>
                  <InfoCard title="环境" open={open.environment} onToggle={() => toggle('environment')}>
                    <EnvironmentCard git={git} workspace={session.workspace} />
                    {gitError ? <div className="detail-note error">{gitError}</div> : null}
                  </InfoCard>

                  <InfoCard title="上下文" open={open.context} onToggle={() => toggle('context')}>
                    <ContextCard context={contextInfo} />
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
