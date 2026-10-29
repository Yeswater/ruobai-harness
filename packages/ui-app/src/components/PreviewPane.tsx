import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type BrowserCastEvent, type PreviewSnapshot, type PreviewState } from '../api.ts'
import { browserBus, previewBus } from '../panel-events.ts'
import { ExternalLinkIcon } from './Icons.tsx'
import { Select } from './Select.tsx'

const LOG_LIMIT = 400
/** Frames arrive as fast as the page changes; the mirror does not need them all. */
const FRAME_INTERVAL_MS = 100

const EXAMPLE = `{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "app",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["dev"],
      "port": 4310
    }
  ]
}`

interface CastState {
  url: string
  title?: string
  width: number
  height: number
  data: string
}

/**
 * The newest cast state per session, kept outside the component.
 *
 * The panel is usually opened *by* the agent's first `open` event, so the pane
 * mounts after that event was delivered; without this it would stare blank
 * until the page happened to repaint.
 */
const latestCast = new Map<string, CastState>()

function castFrom(event: BrowserCastEvent, previous?: CastState): CastState {
  return {
    url: event.url,
    ...(event.title ?? previous?.title ? { title: event.title ?? previous?.title } : {}),
    width: event.width ?? previous?.width ?? 0,
    height: event.height ?? previous?.height ?? 0,
    data: event.data || previous?.data || '',
  }
}

browserBus.subscribe((event) => {
  if (!event.sessionId) return
  if (event.kind === 'close') {
    latestCast.delete(event.sessionId)
    return
  }
  if (event.kind === 'frame' && !event.data) return
  latestCast.set(event.sessionId, castFrom(event, latestCast.get(event.sessionId)))
})

/**
 * Dev-server preview inside the right-hand panel.
 *
 * Configuration comes from `.ruobai/launch.json` (or `.claude/launch.json`);
 * the server is started only by an explicit click, never by a model tool.
 * When the agent opens a page with `browser_open`, its screencast appears here
 * instead: the user watches the same page the model is driving.
 */
export function PreviewPane({ sessionId }: { sessionId?: string }) {
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null)
  const [active, setActive] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [cast, setCast] = useState<CastState | null>(null)
  const [showCast, setShowCast] = useState(true)
  const activeRef = useRef('')
  const sessionRef = useRef(sessionId)
  const lastFrame = useRef(0)
  const pendingFrame = useRef<BrowserCastEvent | null>(null)
  const frameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    sessionRef.current = sessionId
    setCast(sessionId ? latestCast.get(sessionId) ?? null : null)
    setShowCast(true)
  }, [sessionId])

  useEffect(() => {
    const apply = (event: BrowserCastEvent) => {
      setCast(previous => castFrom(event, previous ?? undefined))
    }

    return browserBus.subscribe((event) => {
      if (!sessionRef.current || event.sessionId !== sessionRef.current) return
      if (event.kind === 'open') {
        setShowCast(true)
        apply(event)
        return
      }
      if (event.kind === 'close') {
        setCast(previous => previous?.url === event.url ? null : previous)
        return
      }
      if (!event.data) return
      const now = Date.now()
      if (now - lastFrame.current >= FRAME_INTERVAL_MS) {
        lastFrame.current = now
        apply(event)
        return
      }
      // Keep the newest skipped frame: the last one after a burst is what the
      // page settled on.
      pendingFrame.current = event
      if (frameTimer.current) return
      frameTimer.current = setTimeout(() => {
        frameTimer.current = null
        const next = pendingFrame.current
        pendingFrame.current = null
        if (next) {
          lastFrame.current = Date.now()
          apply(next)
        }
      }, FRAME_INTERVAL_MS)
    })
  }, [])

  useEffect(() => () => {
    if (frameTimer.current) clearTimeout(frameTimer.current)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await api.previewSnapshot()
      setSnapshot(next)
      setError(next.error ?? null)
      setActive(current =>
        current && next.configurations.some(item => item.name === current)
          ? current
          : next.configurations[0]?.name ?? '',
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    return previewBus.subscribe((event) => {
      if (event.kind === 'log') {
        if (event.name === activeRef.current) {
          setLogs(previous => [...previous, event.line].slice(-LOG_LIMIT))
        }
        return
      }
      const state = event.state
      setSnapshot(previous => previous
        ? { ...previous, states: [...previous.states.filter(item => item.name !== state.name), state] }
        : previous)
      if (state.name === activeRef.current && state.status === 'running') {
        setReloadKey(key => key + 1)
      }
    })
  }, [])

  useEffect(() => {
    if (!active) {
      setLogs([])
      return
    }
    let cancelled = false
    void api.previewLogs(active)
      .then(({ logs: next }) => {
        if (!cancelled) setLogs(next.slice(-LOG_LIMIT))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [active])

  const state: PreviewState | undefined = snapshot?.states.find(item => item.name === active)

  const act = async (action: 'start' | 'stop' | 'restart') => {
    if (!active || busy) return
    setBusy(true)
    setError(null)
    // The server resets its log buffer on launch; clear the mirror here too so
    // a previous failed run does not sit above the new one.
    if (action !== 'stop') setLogs([])
    try {
      const next = await api.previewAction(active, action)
      setSnapshot(previous => previous
        ? { ...previous, states: [...previous.states.filter(item => item.name !== next.name), next] }
        : previous)
      if (next.status === 'running') setReloadKey(key => key + 1)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const configurations = snapshot?.configurations ?? []
  const mirror = showCast && cast

  return (
    <div className="preview-pane">
      {cast
        ? (
          <div className="preview-cast-bar">
            <span className="preview-live" aria-hidden />
            <span className="preview-cast-label">{cast.title || '模型页面'}</span>
            <span className="preview-cast-url" title={cast.url}>{cast.url}</span>
            <button
              className="btn ghost compact"
              onClick={() => setShowCast(value => !value)}
              title={showCast ? '查看开发服务器' : '查看模型正在操作的页面'}
            >
              {showCast ? '开发服务器' : '模型页面'}
            </button>
          </div>
        )
        : null}

      {mirror
        ? (
          <div className="preview-cast">
            {cast.data
              ? (
                <img
                  className="preview-cast-frame"
                  src={`data:image/jpeg;base64,${cast.data}`}
                  alt={`模型正在操作 ${cast.url}`}
                />
              )
              : <div className="preview-idle">等待模型页面…</div>}
          </div>
        )
        : (
          <>
            {configurations.length
              ? (
                <div className="preview-toolbar">
                  <Select
                    value={active}
                    options={configurations.map(item => ({ value: item.name, label: item.name }))}
                    onChange={setActive}
                    ariaLabel="预览配置"
                  />
                  <span className={`preview-status is-${state?.status ?? 'stopped'}`}>
                    {statusLabel(state?.status)}
                  </span>
                  <div className="preview-actions">
                    {state?.status === 'running' || state?.status === 'starting'
                      ? (
                        <button className="btn ghost compact" disabled={busy} onClick={() => void act('stop')}>
                          停止
                        </button>
                      )
                      : (
                        <button className="btn primary compact" disabled={busy} onClick={() => void act('start')}>
                          {state?.status === 'failed' ? '重启' : '启动'}
                        </button>
                      )}
                    <button
                      className="icon-btn subtle"
                      onClick={() => setReloadKey(key => key + 1)}
                      aria-label="重新加载页面"
                      title="重新加载页面"
                    >
                      ↻
                    </button>
                    {state?.url
                      ? (
                        <a
                          className="icon-btn subtle"
                          href={state.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="在新标签打开"
                          title="在新标签打开"
                        >
                          <ExternalLinkIcon size={14} />
                        </a>
                      )
                      : null}
                    <button
                      className={`btn ghost compact ${showLogs ? 'active' : ''}`}
                      onClick={() => setShowLogs(value => !value)}
                    >
                      日志
                    </button>
                  </div>
                </div>
              )
              : null}

            {error ? <div className="preview-error">{error}</div> : null}
            {!error && state?.status === 'failed' && state.error
              ? <div className="preview-error">{state.error}</div>
              : null}

            {configurations.length
              ? (
                <div className="preview-frame">
                  {state?.status === 'running' && state.url
                    ? (
                      <iframe
                        key={`${state.url}-${reloadKey}`}
                        src={state.url}
                        title={`预览 ${active}`}
                        className="preview-iframe"
                      />
                    )
                    : (
                      <div className="preview-idle">
                        {state?.status === 'starting'
                          ? '正在启动…'
                          : state?.status === 'failed'
                            ? '启动失败，查看日志'
                            : '服务器未运行'}
                        {state?.url ? <code>{state.url}</code> : null}
                      </div>
                    )}
                </div>
              )
              : (
                <div className="preview-empty">
                  <p>在 <code>{snapshot?.path ?? '.ruobai/launch.json'}</code> 里声明开发服务器。</p>
                  <pre>{EXAMPLE}</pre>
                  <button className="btn ghost compact" onClick={() => void refresh()}>重新读取</button>
                </div>
              )}

            {showLogs && configurations.length
              ? (
                <pre className="preview-logs">{logs.length ? logs.join('\n') : '暂无日志'}</pre>
              )
              : null}
          </>
        )}
    </div>
  )
}

function statusLabel(status: PreviewState['status'] | undefined) {
  if (status === 'running') return '运行中'
  if (status === 'starting') return '启动中'
  if (status === 'failed') return '失败'
  return '已停止'
}
