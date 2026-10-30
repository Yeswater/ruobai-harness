import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ChatSession } from '@ruobai/chat-protocol'
import {
  api,
  type CheckpointChange,
  type ContextInfo,
  type DeliverySnapshot,
  type GitChange,
  type GitInfo,
} from '../api.ts'
import { selectOutputs } from '../output-files.ts'
import { CreatePrDialog } from './CreatePrDialog.tsx'
import { DeliveryPanel } from './DeliveryPanel.tsx'
import { Slot } from './Slot.tsx'
import { FileTypeIcon } from './FileTypeIcon.tsx'
import {
  BranchIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, GearIcon, ListIcon,
} from './Icons.tsx'

interface SessionPanelProps {
  session: ChatSession | null
  onOpenContext: () => void
  onOpenGit: () => void
  onOpenFile: (path: string) => void
  onOpenSettings: () => void
  onOpenChanges: () => void
}

interface GitState {
  info: GitInfo
  changes: GitChange[]
}

const CATEGORY_COLORS = {
  messages: '#3b82f6',
  mcp: '#f97316',
  tools: '#22c55e',
  prompt: '#eab308',
}

/**
 * Right-hand session summary, mirroring Claude Code desktop: environment,
 * context usage, files this session produced, and the working-tree changes.
 *
 * Everything is read-only; rows link into the panels that can act on them
 * (context view, file browser, Git).
 */
export function SessionPanel({
  session, onOpenContext, onOpenGit, onOpenFile, onOpenSettings, onOpenChanges,
}: SessionPanelProps) {
  const [context, setContext] = useState<ContextInfo | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointChange[]>([])
  const [delivery, setDelivery] = useState<DeliverySnapshot | null>(null)
  const [git, setGit] = useState<GitState | null>(null)
  const [allOutputs, setAllOutputs] = useState(false)
  const [prOpen, setPrOpen] = useState(false)

  useEffect(() => {
    if (!session) {
      setContext(null)
      setCheckpoints([])
      setDelivery(null)
      return
    }
    let cancelled = false
    void Promise.all([api.getContext(session.id), api.getCheckpoints(session.id)])
      .then(([nextContext, nextCheckpoints]) => {
        if (cancelled) return
        setContext(nextContext)
        setCheckpoints(nextCheckpoints)
      })
      .catch(() => undefined)
    // Optional panel: a deployment without `delivery-web` has no contract view.
    void api.delivery(session.id)
      .then((next) => {
        if (!cancelled) setDelivery(next)
      })
      .catch(() => {
        if (!cancelled) setDelivery(null)
      })
    return () => {
      cancelled = true
    }
  }, [session?.id, session?.stats, session?.messages.length])

  useEffect(() => {
    if (!session || session.streaming) return
    let cancelled = false
    void api.getGitStatus(session.id)
      .then((next) => {
        if (!cancelled) setGit(next)
      })
      .catch(() => {
        if (!cancelled) setGit(null)
      })
    return () => {
      cancelled = true
    }
  }, [session?.id, session?.streaming, session?.messages.length])

  // The panel lists what the run produced — filtered the way a transcript lists
  // files: build output, dependencies, locks and runtime state stay out, because
  // they are not what the user opened this session to look at.
  const { outputs, hiddenOutputs } = useMemo(() => {
    const byPath = new Map<string, CheckpointChange>()
    for (const change of checkpoints) byPath.set(change.path, change)
    const sorted = [...byPath.values()].sort((left, right) => right.seq - left.seq)
    const { kept, hidden } = selectOutputs(sorted)
    return { outputs: kept, hiddenOutputs: hidden }
  }, [checkpoints])

  if (!session) {
    return <div className="session-panel"><div className="loading">no session</div></div>
  }

  const workspace = session.workspace ?? ''
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? '工作区'
  const branch = git?.info.available ? git.info.branch : null
  const changed = git?.changes ?? []
  const changedPaths = new Set(changed.map(change => change.path))
  const prFiles = outputs.map(change => change.path).filter(path => changedPaths.has(path))
  const base = git?.info.upstream?.replace(/^[^/]+\//, '') || 'main'

  return (
    <div className="session-panel">
      <Section title="环境" icon={<FolderIcon size={14} />}>
        <button className="session-row" onClick={onOpenSettings} title={workspace}>
          <FolderIcon size={14} />
          <span className="session-row-main">
            <span className="session-row-label">{workspaceName}</span>
            <span className="session-row-sub">{workspace || '未选择工作区'}</span>
          </span>
          <GearIcon size={13} />
        </button>
        <button className="session-row" onClick={onOpenGit} disabled={!git?.info.available}>
          <BranchIcon size={14} />
          <span className="session-row-main">
            <span className="session-row-label">{branch ?? (git?.info.available ? 'detached' : '不在 Git 仓库')}</span>
            <span className="session-row-sub">
              {git?.info.available
                ? `${git.info.ahead ? `↑${git.info.ahead} ` : ''}${git.info.behind ? `↓${git.info.behind}` : ''}`.trim() || '与远端同步'
                : '—'}
            </span>
          </span>
        </button>
        <div className="session-row static">
          <ListIcon size={14} />
          <span className="session-row-main">
            <span className="session-row-label">{session.model || '未选择模型'}</span>
            <span className="session-row-sub">
              {[session.provider, session.mode, session.permission].filter(Boolean).join(' · ')}
            </span>
          </span>
        </div>
      </Section>

      <Section title="交付" icon={<ShieldIcon />}>
        <DeliveryPanel delivery={delivery} />
        <Slot name="details.audit" props={{ sessionId: session.id }} />
      </Section>

      <Section
        title="上下文"
        icon={<GaugeIcon />}
        action={<button className="session-link" onClick={onOpenContext}>详情</button>}
      >
        <ContextBody context={context} />
      </Section>

      <Section
        title="输出"
        count={outputs.length}
        action={hiddenOutputs
          ? <span className="session-link muted" title="构建产物、依赖与运行时状态不在列表中">已过滤 {hiddenOutputs}</span>
          : null}
      >
        {outputs.length
          ? (allOutputs ? outputs : outputs.slice(0, 8)).map(change => (
            <button key={change.path} className="session-row" onClick={() => onOpenFile(change.path)} title={change.path}>
              <FileTypeIcon path={change.path} />
              <span className="session-row-main">
                <span className="session-row-label">{basename(change.path)}</span>
                <span className="session-row-sub">{dirname(change.path) || '.'} · {change.tool}</span>
              </span>
              <span className="session-row-value">{formatBytes(change.afterBytes)}</span>
            </button>
          ))
          : <div className="session-empty">本轮还没有文件产出</div>}
        {outputs.length > 8
          ? (
            <button className="session-link more" onClick={() => setAllOutputs(value => !value)}>
              {allOutputs ? '收起' : `还有 ${outputs.length - 8} 个`}
            </button>
          )
          : null}
      </Section>

      <Section
        title="更改"
        action={git?.info.available
          ? <button className="session-link" onClick={onOpenChanges}>查看全部</button>
          : null}
      >
        {git?.info.available
          ? (
            <>
              {/* A diff summary, not a file list: the panel is a glance, and the
                  change page is where the files and hunks belong. */}
              <button
                type="button"
                className="session-change-card"
                onClick={onOpenChanges}
                title="打开更改页"
              >
                <span className="session-change-line">
                  <span className="session-add">+{git.info.added}</span>
                  <span className="session-del">−{git.info.removed}</span>
                  <span className="session-muted">{git.info.files} 个文件</span>
                </span>
                <span className="session-change-open">查看更改 ›</span>
              </button>
              {git.info.files === 0 ? <div className="session-empty">工作区没有未提交改动</div> : null}
              <div className="session-actions">
                <button className="btn ghost compact" onClick={onOpenGit}>Git 面板</button>
                <button
                  className="btn primary compact"
                  disabled={!prFiles.length}
                  title={prFiles.length ? `提交本次会话的 ${prFiles.length} 个文件并创建 PR` : '本次会话没有未提交的改动'}
                  onClick={() => setPrOpen(true)}
                >
                  创建 PR
                </button>
              </div>
            </>
          )
          : <div className="session-empty">当前工作区不是 Git 仓库</div>}
      </Section>
      {prOpen
        ? (
          <CreatePrDialog
            sessionId={session.id}
            files={prFiles}
            title={session.title ? `feat: ${session.title.slice(0, 60)}` : 'feat: 更新'}
            base={base}
            onClose={() => setPrOpen(false)}
          />
        )
        : null}
    </div>
  )
}

function ContextBody({ context }: { context: ContextInfo | null }) {
  if (!context) return <div className="session-empty">统计中…</div>
  const window = context.contextWindow ?? context.compactAt
  const used = context.estimatedTokens
  const free = Math.max(0, window - used)
  const percent = window > 0 ? Math.min(100, (used / window) * 100) : 0

  const rows = [
    { key: 'messages', label: '消息', tokens: context.breakdown.messages, color: CATEGORY_COLORS.messages },
    { key: 'mcpTools', label: 'MCP 工具', tokens: context.breakdown.mcpTools, color: CATEGORY_COLORS.mcp },
    { key: 'systemTools', label: '系统工具', tokens: context.breakdown.systemTools, color: CATEGORY_COLORS.tools },
    { key: 'systemPrompt', label: '系统提示', tokens: context.breakdown.systemPrompt, color: CATEGORY_COLORS.prompt },
    { key: 'free', label: '剩余空间', tokens: free, color: 'var(--border-strong)' },
  ]

  return (
    <>
      <div className="session-context-head">
        <span>已使用 <strong>{Math.round(percent)}%</strong></span>
        <span className="session-muted">{formatTokens(used)} / {formatTokens(window)}</span>
      </div>
      <div className="session-bar" role="img" aria-label="上下文占用">
        {rows.map(row => (
          <span
            key={row.key}
            style={{ width: `${window > 0 ? (row.tokens / window) * 100 : 0}%`, background: row.color }}
          />
        ))}
      </div>
      <div className="session-legend">
        {rows.map(row => (
          <div key={row.key} className="session-legend-row">
            <span className="session-dot" style={{ background: row.color }} />
            <span className="session-legend-label">{row.label}</span>
            <span className="session-legend-tokens">{formatTokens(row.tokens)}</span>
            <span className="session-legend-pct">{window > 0 ? ((row.tokens / window) * 100).toFixed(1) : '0'}%</span>
          </div>
        ))}
      </div>
      {context.mcpTools.length
        ? (
          <div className="session-subline">
            <span>MCP 工具</span>
            <span>{context.mcpTools.length}</span>
          </div>
        )
        : null}
      {context.longMemory
        ? (
          <div className="session-subline">
            <span>记忆条目</span>
            <span>{context.longMemory.items}</span>
          </div>
        )
        : null}
      {context.wiki
        ? (
          <div className="session-subline">
            <span>知识库页面</span>
            <span>{context.wiki.pages}</span>
          </div>
        )
        : null}
    </>
  )
}

function Section({
  title, icon, count, action, children,
}: {
  title: string
  icon?: ReactNode
  count?: number
  action?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className={`session-section ${open ? 'open' : ''}`}>
      <div className="session-section-head">
        <button className="session-section-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          {icon}
          <span>{title}</span>
          {count !== undefined ? <span className="session-count">{count}</span> : null}
        </button>
        {action}
      </div>
      {open ? <div className="session-section-body">{children}</div> : null}
    </section>
  )
}

function GaugeIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 15a8 8 0 1 1 16 0" />
      <path d="m12 15 4-4" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

function dirname(path: string) {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return ''
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(value))
}
