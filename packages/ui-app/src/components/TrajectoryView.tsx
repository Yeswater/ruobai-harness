import { useEffect, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type TrajectoryEvent } from '../api.ts'
import { BranchIcon, ToolIcon } from './Icons.tsx'

type Filter = 'all' | 'tools' | 'context'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'tools', label: '工具' },
  { id: 'context', label: '上下文' },
]

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function labelOf(event: TrajectoryEvent) {
  switch (event.type) {
    case 'message/user': return '用户'
    case 'message/assistant': return '助手'
    case 'tool/result': return '工具结果'
    case 'context/summary': return '上下文压缩'
    case 'context/memory': return '长期记忆'
    case 'turn/error': return '错误'
    case 'turn/notice': return '提示'
    default: return event.type
  }
}

function isToolEvent(event: TrajectoryEvent) {
  return event.type === 'tool/result'
    || (event.type === 'message/assistant'
      && Boolean(event.data?.parts?.some(part => part.type === 'tool-call')))
}

function isContextEvent(event: TrajectoryEvent) {
  return event.type === 'context/summary' || event.type === 'context/memory'
}

function triggerLabel(trigger?: string) {
  if (trigger === 'manual') return '手动'
  if (trigger === 'overflow') return '溢出恢复'
  return '自动'
}

function renderAttachment(
  attachment: { name?: string; kind?: string; path?: string },
  index: number,
) {
  return (
    <span className="traj-chip" key={`${attachment.name}-${index}`}>
      {attachment.kind === 'image' ? '图片' : '文件'} {attachment.name ?? ''}
      {attachment.path ? <span className="traj-chip-path">{attachment.path}</span> : null}
    </span>
  )
}

export function TrajectoryView({ session }: { session: ChatSession | null }) {
  const [events, setEvents] = useState<TrajectoryEvent[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionId = session?.id
  const updatedAt = session?.updatedAt

  useEffect(() => {
    if (!sessionId) {
      setEvents([])
      return
    }
    let cancelled = false
    setLoading(true)
    void api.getTrajectory(sessionId)
      .then((list) => {
        if (cancelled) return
        setEvents(list)
        setError(null)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId, updatedAt, session?.streaming])

  const visible = events.filter((event) => {
    if (!event.data) return false
    if (event.type === 'session/title' || event.type === 'session/meta') return false
    if (event.type === 'message/user' && event.data.source?.kind === 'skill') return false
    if (filter === 'tools') return isToolEvent(event)
    if (filter === 'context') return isContextEvent(event)
    return true
  })

  return (
    <div className="trajectory-view">
      <div className="trajectory-head">
        <div className="trajectory-title">
          <BranchIcon size={14} />
          <span>会话轨迹</span>
          <span className="trajectory-count">{events.length} 条事件</span>
          {loading ? <span className="trajectory-count">加载中…</span> : null}
        </div>
        <div className="trajectory-filters" role="tablist" aria-label="轨迹筛选">
          {FILTERS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className={filter === item.id ? 'active' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="trajectory-empty error">{error}</div> : null}
      {!error && !visible.length
        ? <div className="trajectory-empty">{loading ? '正在读取会话日志…' : '本会话还没有可展示的轨迹。'}</div>
        : null}

      <div className="trajectory-list">
        {visible.map(event => (
          <article key={event.seq} className={`traj-item traj-${event.type.replace(/\//g, '-')}`}>
            <header className="traj-head">
              <span className="traj-type">{labelOf(event)}</span>
              {event.type === 'context/summary'
                ? (
                  <>
                    <span className="traj-badge">{triggerLabel(event.data?.trigger)}</span>
                    <span className="traj-meta">
                      {event.data?.before !== undefined ? `${Math.round(event.data.before / 100) / 10}k` : '?'}
                      {' → '}
                      {event.data?.after !== undefined ? `${Math.round(event.data.after / 100) / 10}k` : '?'}
                      {' tokens'}
                    </span>
                  </>
                )
                : null}
              {event.type === 'context/memory'
                ? <span className="traj-meta">覆盖至 #{event.data?.upToSeq ?? '?'}</span>
                : null}
              {event.type === 'tool/result' && event.data?.isError
                ? <span className="traj-badge error">失败</span>
                : null}
              {event.type === 'turn/notice' && event.data?.kind
                ? <span className="traj-badge">{String(event.data.kind)}</span>
                : null}
              <span className="traj-time mono">{timeOf(event.ts)}</span>
              <span className="traj-seq mono">#{event.seq}</span>
            </header>

            {event.type === 'message/user'
              ? (
                <>
                  <div className="traj-text">{event.data?.text}</div>
                  {event.data?.attachments?.length
                    ? (
                      <div className="traj-chips">
                        {event.data.attachments.map(renderAttachment)}
                      </div>
                    )
                    : null}
                </>
              )
              : null}

            {event.type === 'message/assistant'
              ? (
                <div className="traj-parts">
                  {event.data?.parts?.map((part, index) => {
                    if (part.type === 'text') {
                      return <div className="traj-text" key={index}>{part.text}</div>
                    }
                    if (part.type === 'tool-call') {
                      return (
                        <div className="traj-toolcall" key={part.id ?? index}>
                          <ToolIcon size={12} />
                          <span className="mono">{part.name}</span>
                          <span className="traj-args mono">{part.arguments}</span>
                        </div>
                      )
                    }
                    return null
                  })}
                </div>
              )
              : null}

            {event.type === 'tool/result'
              ? (
                <details className="traj-result">
                  <summary>
                    <ToolIcon size={12} />
                    <span className="mono">{event.data?.name}</span>
                    <span className="traj-meta">
                      {event.data?.chars ?? 0} 字符
                      {event.data?.isError ? ' · 失败' : ''}
                    </span>
                  </summary>
                  <pre>{event.data?.content}</pre>
                </details>
              )
              : null}

            {event.type === 'context/summary'
              ? (
                <details className="traj-checkpoint" open>
                  <summary>检查点摘要（覆盖 #{event.data?.upToSeq ?? '?'}）</summary>
                  <pre>{event.data?.text}</pre>
                </details>
              )
              : null}

            {event.type === 'context/memory'
              ? (
                <details className="traj-checkpoint">
                  <summary>记忆内容 · {event.data?.text?.length ?? 0} 字符</summary>
                  <pre>{event.data?.text}</pre>
                </details>
              )
              : null}

            {event.type === 'turn/error' ? <div className="traj-text error">{event.data?.message}</div> : null}
            {event.type === 'turn/notice'
              ? <div className="traj-text">{String(event.data?.message ?? event.data?.kind ?? '')}</div>
              : null}
          </article>
        ))}
      </div>
    </div>
  )
}
