import { useEffect, useState } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import {
  api, type ContextInfo, type GitInfo, type ProtocolsInfo, type TrajectoryEvent,
} from '../api.ts'
import { CompactionReview, PrunedEntry } from './ContextDetails.tsx'
import { ContextCard, formatTokens } from './ContextCard.tsx'
import { EnvironmentCard } from './EnvironmentCard.tsx'
import { ArchiveIcon } from './Icons.tsx'
import { Slot } from './Slot.tsx'

interface ContextViewProps {
  session: ChatSession | null
  context: ContextInfo | null
  onRefresh: () => void
}

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dateOf(ts: number) {
  return new Date(ts).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function triggerLabel(trigger?: string) {
  if (trigger === 'manual') return '手动'
  if (trigger === 'overflow') return '溢出恢复'
  return '自动'
}

/** Full-page context inspector: session sources, usage, pruning and memory. */
export function ContextView({ session, context, onRefresh }: ContextViewProps) {
  const [events, setEvents] = useState<TrajectoryEvent[]>([])
  const [git, setGit] = useState<GitInfo | null>(null)
  const [protocols, setProtocols] = useState<ProtocolsInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const sessionId = session?.id

  useEffect(() => {
    if (!sessionId) {
      setEvents([])
      setGit(null)
      setProtocols(null)
      return
    }
    let cancelled = false
    void api.getTrajectory(sessionId)
      .then((list) => { if (!cancelled) setEvents(list) })
      .catch(() => { if (!cancelled) setEvents([]) })
    void api.getGitInfo(sessionId)
      .then((info) => { if (!cancelled) setGit(info) })
      .catch(() => { if (!cancelled) setGit(null) })
    void api.getProtocols(sessionId)
      .then((info) => { if (!cancelled) setProtocols(info) })
      .catch(() => { if (!cancelled) setProtocols(null) })
    return () => { cancelled = true }
  }, [sessionId, reload])

  const copy = (value: string, label: string) => {
    const pending = navigator.clipboard?.writeText(value)
    if (!pending) return
    void pending.then(() => {
      setCopied(label)
      setTimeout(() => setCopied(current => current === label ? null : current), 1_500)
    }).catch(() => undefined)
  }

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
  const eventBySeq = new Map(events.map(event => [event.seq, event]))
  const checkpoints = summaries
    .map((event, index) => ({
      event,
      previousUpTo: index ? Number(summaries[index - 1]!.data?.upToSeq ?? -1) : -1,
    }))
    .reverse()
  const pruned = context?.pruned ?? []
  const instructions = protocols?.instructions
  const skills = protocols?.skills?.items ?? []
  const mcpFiles = protocols?.mcp?.files ?? []
  const a2aAgents = protocols?.a2a?.agents ?? []
  const thresholdPercent = context?.contextWindow
    ? Math.round((context.compactAt / context.contextWindow) * 100)
    : undefined

  return (
    <div className="context-view">
      <div className="context-columns">
        <div className="context-col context-main">
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
            {context
              ? (
                <div className="context-formula">
                  窗口 {context.contextWindow ? formatTokens(context.contextWindow) : '未配置'}
                  {' · '}压缩阈值 {formatTokens(context.compactAt)}
                  {thresholdPercent ? `（${thresholdPercent}%）` : ''}
                  {' · '}估算校准 ×{context.calibration.toFixed(2)}
                  {' · '}摘要 {context.summaries} 次
                </div>
              )
              : null}
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
                <h2>上下文来源</h2>
                <p>进入系统提示与工具列表的内容，以及它们当前占用的规模。</p>
              </div>
            </header>
            <div className="context-sources">
              <article className="context-source">
                <div className="context-source-head">
                  <span className="context-source-count">{instructions?.files.length ?? 0}</span>
                  <span>指令文件</span>
                </div>
                {instructions?.files.length
                  ? (
                    <ul>
                      {instructions.files.map(file => (
                        <li key={file.path} title={file.path}>
                          <span className="mono">{file.display}</span>
                          <span className="context-muted">{formatTokens(file.bytes)} 字符</span>
                        </li>
                      ))}
                    </ul>
                  )
                  : <div className="context-muted">未发现 AGENTS.md / CLAUDE.md 等指令文件</div>}
                {instructions?.truncated ? <div className="context-warn">内容已按预算截断</div> : null}
              </article>

              <article className="context-source">
                <div className="context-source-head">
                  <span className="context-source-count">{skills.length}</span>
                  <span>技能</span>
                </div>
                {skills.length
                  ? (
                    <ul>
                      {skills.slice(0, 8).map(skill => (
                        <li key={`${skill.source}:${skill.name}`} title={skill.description}>
                          <span className="mono">/{skill.name}</span>
                          <span className="context-muted">{skill.source === 'global' ? '全局' : '项目'}</span>
                        </li>
                      ))}
                      {skills.length > 8 ? <li className="context-muted">… 其余 {skills.length - 8} 个</li> : null}
                    </ul>
                  )
                  : <div className="context-muted">未发现技能</div>}
              </article>

              <article className="context-source">
                <div className="context-source-head">
                  <span className="context-source-count">{context?.systemTools.length ?? 0}</span>
                  <span>内置工具</span>
                </div>
                <div className="context-tool-list">
                  {(context?.systemTools ?? []).map(name => <span key={name} className="context-chip mono">{name}</span>)}
                  {context?.systemTools.length ? null : <span className="context-muted">暂无</span>}
                </div>
              </article>

              <article className="context-source">
                <div className="context-source-head">
                  <span className="context-source-count">{context?.mcpTools.length ?? 0}</span>
                  <span>MCP 工具</span>
                </div>
                <div className="context-tool-list">
                  {(context?.mcpTools ?? []).map(name => <span key={name} className="context-chip mono">{name}</span>)}
                  {context?.mcpTools.length ? null : <span className="context-muted">未连接 MCP 服务器</span>}
                </div>
                {mcpFiles.length
                  ? (
                    <div className="context-muted">
                      {mcpFiles.length} 个配置文件 · {mcpFiles.reduce((sum, file) => sum + file.count, 0)} 个服务器
                    </div>
                  )
                  : null}
              </article>

              <article className="context-source">
                <div className="context-source-head">
                  <span className="context-source-count">{a2aAgents.length}</span>
                  <span>远端 Agent</span>
                </div>
                {a2aAgents.length
                  ? (
                    <ul>
                      {a2aAgents.slice(0, 6).map(agent => (
                        <li key={agent.id} title={agent.url}>
                          <span className="mono">{agent.name}</span>
                          <span className={`context-muted ${agent.status === 'error' ? 'error' : ''}`}>{agent.status}</span>
                        </li>
                      ))}
                    </ul>
                  )
                  : <div className="context-muted">未配置 A2A agent</div>}
              </article>
            </div>
          </section>

          <section className="context-section">
            <header className="context-section-head">
              <div>
                <h2>压缩检查点</h2>
                <p>展开任意检查点，对比压缩前的事件与压缩后的摘要。</p>
              </div>
            </header>
            {checkpoints.length
              ? (
                <div className="context-entries">
                  {checkpoints.map(({ event, previousUpTo }) => (
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
                      <CompactionReview
                        summary={event}
                        events={events}
                        previousUpTo={previousUpTo}
                      />
                    </article>
                  ))}
                </div>
              )
              : <div className="context-empty">还没有压缩记录。</div>}
          </section>
        </div>

        <aside className="context-col context-side">
          <section className="context-section">
            <header className="context-section-head">
              <div>
                <h2>沙箱</h2>
                <p>本会话的 Seatbelt 边界、守卫与升级策略。</p>
              </div>
            </header>
            <Slot name="context.sandbox" props={{ sessionId }} />
          </section>

          <section className="context-section">
            <header className="context-section-head">
              <div>
                <h2>会话与环境</h2>
                <p>这个会话所在的工作区、模型与运行时信息。</p>
              </div>
              <button
                type="button"
                className="btn ghost compact"
                onClick={() => setReload(value => value + 1)}
              >
                刷新
              </button>
            </header>
            <EnvironmentCard git={git} workspace={session.workspace} />
            <dl className="context-kv">
              <div>
                <dt>会话 ID</dt>
                <dd>
                  <span className="mono">{session.id}</span>
                  <button type="button" className="link-btn" onClick={() => copy(session.id, 'id')}>
                    {copied === 'id' ? '已复制' : '复制'}
                  </button>
                </dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{session.provider ? `${session.provider} / ` : ''}{session.model}</dd>
              </div>
              <div>
                <dt>模式</dt>
                <dd>{session.mode ?? 'agent'}</dd>
              </div>
              <div>
                <dt>权限</dt>
                <dd>{session.permission ?? '默认'}</dd>
              </div>
              <div>
                <dt>消息</dt>
                <dd>{session.messages.length} 条</dd>
              </div>
              <div>
                <dt>时间</dt>
                <dd>{dateOf(session.createdAt)} → {dateOf(session.updatedAt)}</dd>
              </div>
              <div>
                <dt>Git</dt>
                <dd>
                  {git?.available
                    ? `${git.files} 个改动 · +${git.added} / −${git.removed}`
                      + (git.ahead ? ` · 领先 ${git.ahead}` : '')
                      + (git.behind ? ` · 落后 ${git.behind}` : '')
                    : git ? '非 Git 仓库' : '…'}
                </dd>
              </div>
              <div>
                <dt>工作区</dt>
                <dd>
                  <span className="mono">{git?.workspace ?? session.workspace ?? '未选择'}</span>
                  {git?.workspace || session.workspace
                    ? (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => copy(git?.workspace ?? session.workspace ?? '', 'workspace')}
                      >
                        {copied === 'workspace' ? '已复制' : '复制路径'}
                      </button>
                    )
                    : null}
                </dd>
              </div>
            </dl>
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
                <h2>已裁剪的工具输出</h2>
                <p>仅模型视图被截断，会话日志与界面仍保留完整内容。</p>
              </div>
            </header>
            {pruned.length
              ? (
                <div className="context-entries">
                  {pruned.slice().reverse().map(item => (
                    <PrunedEntry key={item.seq} item={item} event={eventBySeq.get(item.seq)} />
                  ))}
                </div>
              )
              : <div className="context-empty">当前没有需要裁剪的旧工具输出。</div>}
          </section>
        </aside>
      </div>
    </div>
  )
}
