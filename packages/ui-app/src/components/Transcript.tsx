import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ChatSession, ReasoningBlock, ToolBlock } from '@ruobai/chat-protocol'
import { BrainIcon, CheckIcon, ChevronDownIcon, SparkIcon, ToolIcon } from './Icons.tsx'
import { AttachmentRail } from './AttachmentRail.tsx'
import { useContextMenu } from './ContextMenu.tsx'
import { TurnNav } from './TurnNav.tsx'
import { describeTool, isRunning as isToolRunning, toolDetail } from '../tool-summary.ts'
import {
  buildPlan, groupSummary, isGroupRunning, type ProcessItem,
} from '../transcript-model.ts'

interface TranscriptProps {
  session: ChatSession | null
  onSuggestion: (text: string) => void
}

const SUGGESTIONS = [
  '解释一下 Cordis 的 fiber 生命周期',
  '帮我看一下 loader 的源码',
  '给 UI 加一个会话搜索',
]

const FOLLOW_THRESHOLD = 24

export function Transcript({ session, onSuggestion }: TranscriptProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const lastSessionRef = useRef<string | null>(null)
  const lastMessageRef = useRef<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const messages = session?.messages ?? []
  const plan = useMemo(() => buildPlan(messages), [messages])

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
            <div className="empty">
              <div className="empty-mark"><SparkIcon size={26} /></div>
              <h2>从这里开始</h2>
              <p>由 ruobai-chat 服务驱动的本地会话。发一条消息，查看流式输出、工具卡片和右侧运行时面板。</p>
              <div className="suggestions">
                {SUGGESTIONS.map(text => (
                  <button key={text} className="suggestion" onClick={() => onSuggestion(text)}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {plan.map((item) => {
            if (item.kind === 'user') return <UserMessage key={item.key} message={item.message} />
            if (item.kind === 'text') {
              return (
                <div className="prose markdown" key={item.key}>
                  <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
                  {item.streaming ? <span className="caret" /> : null}
                </div>
              )
            }
            if (item.kind === 'pending') {
              return <div className="prose thinking" key={item.key}><span className="caret" /> 思考中…</div>
            }
            return (
              <ProcessGroup
                key={item.key}
                items={item.items}
                // The turn's live flag is the authority: a group left behind by a
                // finished turn is never "running", even without timing stamps.
                streaming={Boolean(session?.streaming)}
              />
            )
          })}
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

function UserMessage({ message }: { message: ChatMessage }) {
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
    <div className="msg user" id={`msg-${message.id}`} onContextMenu={onContextMenu}>
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
function ProcessGroup({ items, streaming }: { items: ProcessItem[]; streaming: boolean }) {
  const running = streaming && isGroupRunning(items)
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
            {items.map(item => item.kind === 'reasoning'
              ? <ThoughtRow key={item.key} block={item.block} />
              : <ToolRow key={item.key} block={item.block} />)}
          </div>
        )
        : null}
    </div>
  )
}

function duration(block: { startedAt?: number; finishedAt?: number }) {
  if (block.startedAt === undefined || block.finishedAt === undefined) return ''
  const seconds = Math.round((block.finishedAt - block.startedAt) / 1000)
  return seconds >= 1 ? `${seconds}s` : ''
}

function firstLine(text: string, limit = 110) {
  const line = text.split('\n').find(item => item.trim())?.trim() ?? text.trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function ThoughtRow({ block }: { block: ReasoningBlock }) {
  const [open, setOpen] = useState(false)
  const live = block.finishedAt === undefined
  const elapsed = duration(block)

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
        {live ? <span className="process-row-state">思考中</span> : elapsed ? <span className="process-row-meta">{elapsed}</span> : null}
      </button>
      {open
        ? <div className="process-row-body prose">{block.text}</div>
        : null}
    </div>
  )
}

function ToolRow({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false)
  const detail = toolDetail(block)
  const running = isToolRunning(block)
  const elapsed = running ? '' : duration(block)

  return (
    <div className={`process-row ${open ? 'expanded' : ''} ${block.isError ? 'failed' : ''}`}>
      <button
        type="button"
        className="process-row-head"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <ToolIcon size={12} />
        <span className="process-row-label">{detail.row}</span>
        {detail.summary ? <span className="process-row-sep">·</span> : null}
        <span className="process-row-text">{detail.summary}</span>
        {running
          ? <span className="process-row-state">运行中</span>
          : block.isError
            ? <span className="process-row-state failed">失败</span>
            : elapsed ? <span className="process-row-meta">{elapsed}</span> : null}
      </button>
      {open
        ? (
          <div className="process-row-body">
            {detail.command
              ? <pre className="tool-command">$ {detail.command}</pre>
              : detail.path ? <div className="tool-path">{detail.path}</div> : null}
            <pre className="tool-output">{block.output || (block.isError ? 'failed' : 'running…')}</pre>
            <div className="process-row-hint">{describeTool(block)}</div>
          </div>
        )
        : null}
    </div>
  )
}
