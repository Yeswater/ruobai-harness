import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ChatSession, ReasoningBlock, ToolBlock } from '@ruobai/chat-protocol'
import type { ActivitySummary } from '../api.ts'
import { BrainIcon, CheckIcon, ChevronDownIcon, ToolIcon } from './Icons.tsx'
import { AttachmentRail } from './AttachmentRail.tsx'
import { ContributionGraph } from './ContributionGraph.tsx'
import { useContextMenu } from './ContextMenu.tsx'
import { TurnNav } from './TurnNav.tsx'
import { toolDetail, toolEdit, type ToolEdit } from '../tool-summary.ts'
import { addedLines, diffLines } from '../tool-diff.ts'
import {
  buildPlan, formatDuration, groupSummary, isGroupRunning, itemDuration, shouldGroupRun,
  type ProcessItem,
  type StepItem,
} from '../transcript-model.ts'

interface TranscriptProps {
  session: ChatSession | null
  /** Daily user activity for the empty-session contribution graph. */
  activity: ActivitySummary | null
  /** Take a queued message back into the input box for editing. */
  onEditQueued?: (queuedId: string) => void
  /** Discard a queued message. */
  onWithdrawQueued?: (queuedId: string) => void
}

const FOLLOW_THRESHOLD = 24

export function Transcript({
  session, activity, onEditQueued, onWithdrawQueued,
}: TranscriptProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const lastSessionRef = useRef<string | null>(null)
  const lastMessageRef = useRef<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const messages = session?.messages ?? []
  const queued = session?.queued ?? []
  const queuedIds = new Set(queued.map(item => item.id))
  const plan = useMemo(() => buildPlan(messages, Boolean(session?.streaming)), [messages, session?.streaming])

  const last = messages.at(-1)
  const lastBlock = last?.blocks.at(-1)
  const lastText = lastBlock?.type === 'text' ? lastBlock.text.length : 0

  const scrollToBottom = () => {
    const box = boxRef.current
    if (!box) return
    box.scrollTop = box.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const id = session?.id ?? null
    const lastMessage = messages.at(-1)
    const lastId = lastMessage?.id ?? null

    if (id !== lastSessionRef.current) {
      box.scrollTop = box.scrollHeight
      atBottomRef.current = true
      setAtBottom(true)
    } else if (lastMessage?.role === 'user' && lastId !== lastMessageRef.current) {
      // Own words must be visible: a new user message always jumps to the bottom.
      box.scrollTop = box.scrollHeight
      atBottomRef.current = true
      setAtBottom(true)
    } else if (atBottomRef.current) {
      box.scrollTop = box.scrollHeight
    }

    lastSessionRef.current = id
    lastMessageRef.current = lastId
  }, [session?.id, messages.length, lastText])

  useEffect(() => {
    const box = boxRef.current
    const inner = innerRef.current
    if (!box || !inner) return
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) box.scrollTop = box.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="transcript-wrap">
      <div
        className="transcript"
        ref={boxRef}
        onScroll={(event) => {
          const box = event.currentTarget
          const bottom = box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_THRESHOLD + 1
          atBottomRef.current = bottom
          setAtBottom(bottom)
        }}
      >
        <div className="transcript-inner" ref={innerRef}>
          {!session ? (
            <div className="loading">loading session…</div>
          ) : messages.length === 0 ? (
            <div className="contrib-screen">
              <ContributionGraph activity={activity} />
            </div>
          ) : null}

          {plan.map((item, index) => {
            if (item.kind === 'user') {
              return (
                <UserMessage
                  key={item.key}
                  message={item.message}
                  queued={queuedIds.has(item.message.id)}
                />
              )
            }
            if (item.kind === 'text') {
              return (
                <div className="prose markdown" key={item.key}>
                  <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
                  {item.streaming ? <span className="caret" /> : null}
                </div>
              )
            }
            return (
              <ProcessGroup
                key={item.key}
                items={item.items}
                placeholder={Boolean(item.placeholder)}
                // The turn's live flag is the authority: a group left behind by a
                // finished turn is never "running", even without timing stamps.
                streaming={Boolean(session?.streaming)}
                // Between two model steps the latest group has no pending row yet,
                // but the turn still has work coming; keep it open instead of
                // folding and re-opening the same group at every round trip.
                active={index === plan.length - 1}
              />
            )
          })}

          {/* Queued messages are not in the log yet: the host admits them at the
              next step boundary of the running turn, so they are drawn from the
              queue until then. */}
          {queued.filter(item => !messages.some(message => message.id === item.id)).map(item => (
            <UserMessage
              key={item.id}
              queued
              onEdit={onEditQueued ? () => onEditQueued(item.id) : undefined}
              onWithdraw={onWithdrawQueued ? () => onWithdrawQueued(item.id) : undefined}
              message={{
                id: item.id,
                role: 'user',
                blocks: [
                  ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
                  ...(item.attachments ?? []).map(attachment => ({
                    type: 'attachment' as const,
                    attachment,
                  })),
                ],
                status: 'done',
                createdAt: item.createdAt,
              }}
            />
          ))}
        </div>

        {!atBottom && messages.length
          ? (
            <div className="to-bottom-slot">
              <button className="to-bottom" onClick={scrollToBottom} aria-label="回到底部" title="回到底部">
                <ChevronDownIcon size={16} />
              </button>
            </div>
          )
          : null}
      </div>
      <TurnNav containerRef={boxRef} messages={messages} />
    </div>
  )
}

function UserMessage({ message, queued, onEdit, onWithdraw }: {
  message: ChatMessage
  queued?: boolean
  onEdit?: () => void
  onWithdraw?: () => void
}) {
  const contextMenu = useContextMenu()
  const text = message.blocks.map(block => block.type === 'text' ? block.text : '').join('')
  const attachments = message.blocks
    .filter(block => block.type === 'attachment')
    .map(block => block.attachment)

  const onContextMenu = (event: ReactMouseEvent) => {
    contextMenu.open(event, [
      {
        label: '复制消息',
        disabled: !text.trim(),
        onSelect: () => { void navigator.clipboard.writeText(text).catch(() => undefined) },
      },
      { separator: true },
      {
        label: '复制消息 ID',
        onSelect: () => { void navigator.clipboard.writeText(message.id).catch(() => undefined) },
      },
    ])
  }

  return (
    <div
      className={`msg user ${queued ? 'queued' : ''}`}
      id={`msg-${message.id}`}
      onContextMenu={onContextMenu}
    >
      {queued
        ? (
          <div className="msg-queued">
            <span>排队中 · 当前步骤结束后发给模型</span>
            {onEdit || onWithdraw
              ? (
                <span className="msg-queued-actions">
                  {onEdit
                    ? (
                      <button type="button" className="msg-queued-action" onClick={onEdit} title="撤回并放回输入框，编辑后重新发送">
                        编辑
                      </button>
                    )
                    : null}
                  {onWithdraw
                    ? (
                      <button type="button" className="msg-queued-action" onClick={onWithdraw} title="丢弃这条消息">
                        撤回
                      </button>
                    )
                    : null}
                </span>
              )
              : null}
          </div>
        )
        : null}
      {attachments.length ? <AttachmentRail attachments={attachments} /> : null}
      {text ? <div className="bubble">{text}</div> : null}
    </div>
  )
}

/**
 * Everything the turn did between two paragraphs: thoughts and tool calls.
 *
 * It stays open while work is in flight so the user can watch the run, then
 * collapses to `已完成，用时 1分30秒`. A click pins the state until the next
 * action starts, so reading a finished run does not fight the auto-fold.
 */
function StepRow({ item }: { item: StepItem }) {
  if (item.kind === 'reasoning') return <ThoughtRow block={item.block} pending={item.pending} />
  if (item.kind === 'text') return <TextRow text={item.text} />
  return <ToolRow block={item.block} pending={item.pending} />
}

/**
 * One prose-led section of a finished turn.
 *
 * This is the fold the user asked for on top of the turn summary: the turn
 * opens into its paragraphs, and each paragraph keeps the steps it introduced.
 * Opening a section shows the prose and those steps; opening a step shows the
 * command and its output.
 */
function SegmentRow({ text, items }: { text?: string; items: StepItem[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`process-row segment ${open ? 'expanded' : ''}`}>
      <button
        type="button"
        className="process-row-head"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span className="process-row-label">{text ? '正文' : '过程'}</span>
        <span className="process-row-text">
          {open ? '' : text ? firstLine(text) : `${items.length} 步`}
        </span>
        <span className="process-row-chevron"><ChevronDownIcon size={12} /></span>
      </button>
      {open
        ? (
          <>
            {text
              ? (
                <div className="process-row-body prose markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
                </div>
              )
              : null}
            <div className="process-segment-body">
              {items.map(item => <StepRow key={item.key} item={item} />)}
            </div>
          </>
        )
        : null}
    </div>
  )
}

function ProcessGroup({ items, placeholder, streaming, active }: {
  items: ProcessItem[]
  placeholder?: boolean
  streaming: boolean
  /** The last group in a streaming turn still has steps ahead of it. */
  active: boolean
}) {
  // A step that has produced nothing yet keeps the group "running": one row,
  // one state, instead of a separate 「思考中…」 line that comes and goes.
  // The newest group stays open for the whole streaming turn even between tool
  // round trips, when none of its rows is pending at this exact moment.
  const running = shouldGroupRun({
    streaming,
    active,
    placeholder,
    running: isGroupRunning(items),
  })
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? running

  useEffect(() => {
    // New work re-opens the group; the previous pin is stale from here on.
    if (running) setOverride(null)
  }, [running, items.length])

  return (
    <div className={`process ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="process-head"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        {running
          ? <ToolIcon size={12} />
          : <CheckIcon size={12} />}
        <span className="process-title">{running ? '执行中…' : groupSummary(items)}</span>
        <ChevronDownIcon size={12} />
      </button>

      {open
        ? (
          <div className="process-body">
            {items.map(item => item.kind === 'segment'
              ? <SegmentRow key={item.key} text={item.text} items={item.items} />
              : <StepRow key={item.key} item={item} />)}
            {placeholder && !items.length
              ? <div className="process-row waiting"><span className="caret" /> 思考中…</div>
              : null}
          </div>
        )
        : null}
    </div>
  )
}

/** Row-level elapsed label: `1.2s`, `12s`, `1m30s`. */
function durationLabel(ms: number | undefined) {
  if (ms === undefined || ms < 1000) return ''
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds)}s`
  return formatDuration(ms)
}

function firstLine(text: string, limit = 110) {
  const line = text.split('\n').find(item => item.trim())?.trim() ?? text.trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/**
 * Prose folded into a finished turn.
 *
 * The group's open state is the middle level: rows stay collapsed and show a
 * one-line title. Clicking this row is the third level and reveals the text.
 */
function TextRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`process-row ${open ? 'expanded' : ''}`}>
      <button
        type="button"
        className="process-row-head"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span className="process-row-label">正文</span>
        <span className="process-row-text">{open ? '' : firstLine(text)}</span>
        <span className="process-row-chevron"><ChevronDownIcon size={12} /></span>
      </button>
      {open
        ? (
          <div className="process-row-body prose markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
          </div>
        )
        : null}
    </div>
  )
}

function ThoughtRow({ block, pending }: { block: ReasoningBlock; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const elapsed = durationLabel(itemDuration({ kind: 'reasoning', key: '', block, pending }))

  return (
    <div className={`process-row ${open ? 'expanded' : ''}`}>
      <button
        type="button"
        className="process-row-head"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <BrainIcon size={12} />
        <span className="process-row-label">思考</span>
        <span className="process-row-sep">·</span>
        <span className="process-row-text">{open ? '' : firstLine(block.text)}</span>
        {pending ? <span className="process-row-state">思考中</span> : elapsed ? <span className="process-row-meta">{elapsed}</span> : null}
        <span className="process-row-chevron"><ChevronDownIcon size={12} /></span>
      </button>
      {open
        ? <div className="process-row-body prose">{block.text}</div>
        : null}
    </div>
  )
}

function ToolRow({ block, pending }: { block: ToolBlock; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const detail = toolDetail(block)
  const edit = toolEdit(block)
  const elapsed = durationLabel(itemDuration({ kind: 'tool', key: '', block, pending }))

  return (
    <div className={`process-row ${open ? 'expanded' : ''} ${block.isError ? 'failed' : ''}`}>
      <button
        type="button"
        className="process-row-head"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <ToolIcon size={12} />
        <span className="process-row-label">{detail.title}</span>
        {detail.summary && detail.title === '运行命令'
          ? <span className="process-row-text">{detail.summary}</span>
          : null}
        {pending
          ? <span className="process-row-state">运行中</span>
          : block.isError
            ? <span className="process-row-state failed">失败</span>
            : elapsed ? <span className="process-row-meta">{elapsed}</span> : null}
        <span className="process-row-chevron"><ChevronDownIcon size={12} /></span>
      </button>
      {open
        ? (
          <div className={`process-row-body ${edit ? 'diff-body' : ''}`}>
            {edit
              ? (
                <>
                  <ToolDiff edit={edit} />
                  {block.isError
                    ? <pre className="tool-output">{block.output || 'failed'}</pre>
                    : null}
                </>
              )
              : (
                <>
                  {detail.command
                    ? <pre className="tool-command">$ {detail.command}</pre>
                    : detail.path ? <div className="tool-path">{detail.path}</div> : null}
                  <pre className="tool-output">{block.output || (block.isError ? 'failed' : pending ? 'running…' : '无输出')}</pre>
                </>
              )}
          </div>
        )
        : null}
    </div>
  )
}

const DIFF_RENDER_LIMIT = 200

/** The edit/write change, styled as a compact Claude Code-like diff. */
function ToolDiff({ edit }: { edit: ToolEdit }) {
  const lines = useMemo(
    () => edit.content !== undefined
      ? addedLines(edit.content)
      : diffLines(edit.oldText ?? '', edit.newText ?? ''),
    [edit],
  )
  const added = lines.filter(line => line.kind === 'add').length
  const removed = lines.filter(line => line.kind === 'del').length
  const shown = lines.slice(0, DIFF_RENDER_LIMIT)

  return (
    <div className="tool-diff">
      <div className="tool-diff-head">
        <span className="tool-diff-path" title={edit.path}>{edit.path}</span>
        <span className="tool-diff-stats">
          <span className="add">+{added}</span>
          <span className="del">−{removed}</span>
        </span>
      </div>
      <div className="tool-diff-body">
        {shown.map((line, index) => (
          <div className={`tool-diff-row ${line.kind}`} key={index}>
            <span className="tool-diff-gutter">
              {line.kind === 'del' ? line.oldLine : line.newLine}
            </span>
            <span className="tool-diff-sign">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
            </span>
            <span className="tool-diff-text">{line.text || ' '}</span>
          </div>
        ))}
        {!lines.length ? <div className="tool-diff-empty">没有可显示的差异</div> : null}
        {lines.length > shown.length
          ? <div className="tool-diff-more">… 还有 {lines.length - shown.length} 行</div>
          : null}
      </div>
    </div>
  )
}
