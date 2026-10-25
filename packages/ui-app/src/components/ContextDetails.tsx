import { useState } from 'react'
import type { TrajectoryEvent } from '../api.ts'
import { formatTokens } from './ContextCard.tsx'
import { ChevronRightIcon } from './Icons.tsx'
import { eventLabel, eventPreview, eventText, timeOf } from './trajectory-helpers.ts'

function EventRow({ event }: { event: TrajectoryEvent }) {
  const [open, setOpen] = useState(false)
  const text = eventText(event)
  const clipped = typeof event.data?.chars === 'number'
    && event.type === 'tool/result'
    && event.data.chars > text.length
  return (
    <div className="compact-event">
      <button
        type="button"
        className="compact-event-head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="compact-event-kind">{eventLabel(event)}</span>
        <span className="compact-event-seq mono">#{event.seq}</span>
        <span className="compact-event-preview">{eventPreview(event)}</span>
        <span className="compact-event-time">{timeOf(event.ts)}</span>
        <span className={`context-caret ${open ? 'open' : ''}`}>
          <ChevronRightIcon size={11} />
        </span>
      </button>
      {open
        ? (
          <pre className="compact-body">
            {text || '（没有可显示的文本内容）'}
            {clipped ? '\n\n…（会话轨迹只保留前 12,000 字符，完整内容以会话日志为准）' : ''}
          </pre>
        )
        : null}
    </div>
  )
}

interface CompactionReviewProps {
  summary: TrajectoryEvent
  events: TrajectoryEvent[]
  previousUpTo: number
}

/** Expand one checkpoint into its pre-compaction events and the summary. */
export function CompactionReview({ summary, events, previousUpTo }: CompactionReviewProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'before' | 'after'>('after')
  const upTo = Number(summary.data?.upToSeq ?? -1)
  const covered = events.filter(event =>
    event.seq > previousUpTo
    && event.seq <= upTo
    && event.type !== 'session/meta'
    && event.type !== 'session/title')
  const retained = events.filter(event =>
    event.seq > upTo
    && event.type !== 'session/meta'
    && event.type !== 'session/title').length

  return (
    <div className="compact-review">
      <button
        type="button"
        className="context-toggle"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className={`context-caret ${open ? 'open' : ''}`}>
          <ChevronRightIcon size={11} />
        </span>
        {open ? '收起压缩前后' : `查看压缩前后 · 前 ${covered.length} 条`}
      </button>

      {open
        ? (
          <>
            <div className="context-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'before'}
                className={tab === 'before' ? 'active' : ''}
                onClick={() => setTab('before')}
              >
                压缩前 · {covered.length} 条事件
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'after'}
                className={tab === 'after' ? 'active' : ''}
                onClick={() => setTab('after')}
              >
                压缩后 · 摘要
              </button>
            </div>
            {tab === 'before'
              ? (covered.length
                ? <div className="compact-events">{covered.map(event => <EventRow key={event.seq} event={event} />)}</div>
                : <div className="context-empty">这条检查点没有覆盖任何事件。</div>)
              : (
                <>
                  <pre className="compact-body summary">{summary.data?.text || '（没有摘要文本）'}</pre>
                  <div className="compact-note">摘要之后的 {retained} 条事件保留原文进入模型上下文。</div>
                </>
              )}
          </>
        )
        : null}
    </div>
  )
}

interface PrunedEntryProps {
  item: { seq: number; name: string; before: number; after: number; text?: string }
  event?: TrajectoryEvent
}

/** One pruned tool output, with the model-view text and the original result. */
export function PrunedEntry({ item, event }: PrunedEntryProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'after' | 'before'>('after')
  const original = event?.data?.content ?? ''
  const clipped = typeof event?.data?.chars === 'number' && event.data.chars > original.length
  const after = item.text ?? ''

  return (
    <article className="context-entry compact">
      <div className="context-entry-head">
        <span className="mono">#{item.seq}</span>
        <span className="mono">{item.name || 'tool'}</span>
        <span className="context-entry-size">
          {formatTokens(item.before)} → {formatTokens(item.after)} 字符
        </span>
        <button
          type="button"
          className="context-toggle inline"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
        >
          {open ? '收起内容' : '查看前后内容'}
        </button>
      </div>
      {open
        ? (
          <>
            <div className="context-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'after'}
                className={tab === 'after' ? 'active' : ''}
                onClick={() => setTab('after')}
              >
                模型视图 · 裁剪后
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'before'}
                className={tab === 'before' ? 'active' : ''}
                onClick={() => setTab('before')}
              >
                原始输出 · {formatTokens(item.before)} 字符
              </button>
            </div>
            {tab === 'after'
              ? (after
                ? <pre className="compact-body">{after}</pre>
                : <div className="context-empty">这个版本的服务端没有返回裁剪后的文本。</div>)
              : (original
                ? (
                  <pre className="compact-body">
                    {original}
                    {clipped ? '\n\n…（会话轨迹只保留前 12,000 字符，完整内容以会话日志为准）' : ''}
                  </pre>
                )
                : <div className="context-empty">没有在会话轨迹中找到这条工具结果。</div>)}
          </>
        )
        : null}
    </article>
  )
}
