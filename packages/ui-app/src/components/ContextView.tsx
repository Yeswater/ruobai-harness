import { useEffect, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import { api, type ContextInfo, type TrajectoryEvent } from '../api.ts'
import { ContextCard, formatTokens } from './ContextCard.tsx'
import { ArchiveIcon } from './Icons.tsx'

interface ContextViewProps {
  session: ChatSession | null
  context: ContextInfo | null
  onRefresh: () => void
}

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function triggerLabel(trigger?: string) {
  if (trigger === 'manual') return '手动'
  if (trigger === 'overflow') return '溢出恢复'
  return '自动'
}

/** Full-page context inspector: usage, pruning, checkpoints and memory. */
export function ContextView({ session, context, onRefresh }: ContextViewProps) {
  const [events, setEvents] = useState<TrajectoryEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const sessionId = session?.id

  useEffect(() => {
    if (!sessionId) {
      setEvents([])
      return
    }
    let cancelled = false
    void api.getTrajectory(sessionId)
      .then((list) => { if (!cancelled) setEvents(list) })
      .catch(() => { if (!cancelled) setEvents([]) })
    return () => { cancelled = true }
  }, [sessionId, session?.updatedAt, reload])

  const compact = () => {
    if (!sessionId || busy || session.streaming) return
    setBusy(true)
    setNotice(null)
    setError(null)
    void api.compactSession(sessionId)
      .then((result) => {
        setNotice(result.compacted && result.info
          ? `已压缩：${formatTokens(result.info.before)} → ${formatTokens(result.info.after)} tokens`
          : '没有可压缩的历史，或压缩未产生明显收益。')
        setReload(value => value + 1)
        onRefresh()
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false))
  }

  if (!session) return <div className="trajectory-empty">请先选择一个会话。</div>

  const summaries = events.filter(event => event.type === 'context/summary')
  const memories = events.filter(event => event.type === 'context/memory')
  const pruned = context?.pruned ?? []

  return (
    <div className="context-view">
      <section className="context-section">
        <header className="context-section-head">
          <div>
            <h2>上下文占用</h2>
            <p>模型请求的估算构成、压缩阈值与校准状态。</p>
          </div>
          <button
            type="button"
            className="btn compact"
            onClick={compact}
            disabled={busy || session.streaming}
            title="立即把较早的历史压缩成检查点"
          >
            <ArchiveIcon size={13} />
            {busy ? '压缩中…' : '立即压缩'}
          </button>
        </header>
        <ContextCard context={context} />
        {notice ? <div className="context-note">{notice}</div> : null}
        {error ? <div className="context-note error">{error}</div> : null}
        {context?.compaction.disabled
          ? (
            <div className="context-note error">
              自动压缩已暂停（连续失败 {context.compaction.failures} 次）。可以手动压缩一次以恢复。
            </div>
          )
          : null}
        {context?.compaction.lastError && !context.compaction.disabled
          ? <div className="context-note error">上次压缩错误：{context.compaction.lastError}</div>
          : null}
      </section>

      <section className="context-section">
        <header className="context-section-head">
          <div>
            <h2>滚动记忆</h2>
            <p>会话空闲时增量维护，覆盖切点时可直接替代一次摘要调用。</p>
          </div>
        </header>
        {context?.memory
          ? (
            <div className="context-memory">
              <span>最近更新 {timeOf(context.memory.at)}</span>
              <span>覆盖至 #{context.memory.upToSeq}</span>
              <span>{context.memory.chars} 字符</span>
            </div>
          )
          : <div className="context-empty">尚未生成，超过压缩阈值的 60% 后会自动维护。</div>}
        {memories.length
          ? (
            <details className="context-details">
              <summary>历史记忆 {memories.length} 条</summary>
              {memories.slice(-8).reverse().map(event => (
                <div className="context-entry" key={event.seq}>
                  <div className="context-entry-head">
                    <span>{timeOf(event.ts)} · 覆盖至 #{event.data?.upToSeq ?? '?'}</span>
                  </div>
                  <pre>{event.data?.text}</pre>
                </div>
              ))}
            </details>
          )
          : null}
      </section>

      <section className="context-section">
        <header className="context-section-head">
          <div>
            <h2>压缩检查点</h2>
            <p>每次摘要覆盖的事件范围、触发原因与前后体积。</p>
          </div>
        </header>
        {summaries.length
          ? (
            <div className="context-entries">
              {summaries.slice().reverse().map(event => (
                <article className="context-entry" key={event.seq}>
                  <div className="context-entry-head">
                    <span className="context-badge">{triggerLabel(event.data?.trigger)}</span>
                    <span>{timeOf(event.ts)} · 覆盖至 #{event.data?.upToSeq ?? '?'}</span>
                    <span className="context-entry-size">
                      {formatTokens(Number(event.data?.before ?? 0))}
                      {' → '}
                      {formatTokens(Number(event.data?.after ?? 0))}
                    </span>
                  </div>
                  <details className="context-details">
                    <summary>查看摘要</summary>
                    <pre>{event.data?.text}</pre>
                  </details>
                </article>
              ))}
            </div>
          )
          : <div className="context-empty">还没有压缩记录。</div>}
      </section>

      <section className="context-section">
        <header className="context-section-head">
          <div>
            <h2>已裁剪的工具输出</h2>
            <p>仅模型视图被截断，会话日志与界面仍保留完整内容。</p>
          </div>
        </header>
        {pruned.length
          ? (
            <div className="context-entries">
              {pruned.slice().reverse().map(item => (
                <article className="context-entry compact" key={item.seq}>
                  <div className="context-entry-head">
                    <span className="mono">#{item.seq}</span>
                    <span className="mono">{item.name || 'tool'}</span>
                    <span className="context-entry-size">
                      {formatTokens(item.before)} → {formatTokens(item.after)} 字符
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )
          : <div className="context-empty">当前没有需要裁剪的旧工具输出。</div>}
      </section>
    </div>
  )
}
