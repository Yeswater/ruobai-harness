import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ChatSession, ReasoningBlock, ToolBlock } from '@ruobai/chat-protocol'
import { BrainIcon, ChevronDownIcon, SparkIcon, ToolIcon } from './Icons.tsx'
import { AttachmentRail } from './AttachmentRail.tsx'
import { useContextMenu } from './ContextMenu.tsx'
import { TurnNav } from './TurnNav.tsx'
import { describeToolRun, isRunning, toolDetail } from '../tool-summary.ts'
import { buildPlan, segmentsOf } from '../transcript-model.ts'

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
  const currentTurnStart = session ? lastUserIndex(messages) : -1
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

          {plan.map((item) => item.kind === 'run'
            ? <ToolRun key={item.key} blocks={item.blocks} />
            : (
              <Message
                key={item.key}
                message={item.message}
                // Thoughts stay unfolded while the turn runs; the fold closes only
                // once the whole turn ends, so a multi-step run keeps its context.
                activeTurn={Boolean(session?.streaming) && item.index > currentTurnStart}
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

function lastUserIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

function Message({ message, activeTurn }: { message: ChatMessage; activeTurn: boolean }) {
  const contextMenu = useContextMenu()
  const fullText = message.blocks
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('\n')
    .trim()

  const onContextMenu = (event: ReactMouseEvent) => {
    contextMenu.open(event, [
      {
        label: '复制消息',
        disabled: !fullText,
        onSelect: () => { void navigator.clipboard.writeText(fullText).catch(() => undefined) },
      },
      { separator: true },
      {
        label: '复制消息 ID',
        onSelect: () => { void navigator.clipboard.writeText(message.id).catch(() => undefined) },
      },
    ])
  }

  if (message.role === 'user') {
    const text = message.blocks.map(block => block.type === 'text' ? block.text : '').join('')
    const attachments = message.blocks
      .filter(block => block.type === 'attachment')
      .map(block => block.attachment)
    return (
      <div className="msg user" id={`msg-${message.id}`} onContextMenu={onContextMenu}>
        {attachments.length ? <AttachmentRail attachments={attachments} /> : null}
        {text ? <div className="bubble">{text}</div> : null}
      </div>
    )
  }

  return (
    <div className="msg assistant" id={`msg-${message.id}`} onContextMenu={onContextMenu}>
      <div className="msg-body">
        {segmentsOf(message).map((segment) => {
          if (segment.kind === 'run') return <ToolRun key={segment.key} blocks={segment.blocks} />
          const { block, index } = segment
          if (block.type === 'text') {
            return (
              <div className="prose markdown" key={index}>
                <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
                {message.status === 'streaming' && index === message.blocks.length - 1
                  ? <span className="caret" />
                  : null}
              </div>
            )
          }
          if (block.type === 'reasoning') {
            return (
              <ThinkingCard
                key={index}
                block={block}
                expanded={activeTurn || message.status === 'streaming'}
                live={message.status === 'streaming'}
              />
            )
          }
          return null
        })}
        {message.status === 'streaming' && message.blocks.length === 0
          ? <div className="prose thinking"><span className="caret" /> 思考中…</div>
          : null}
      </div>
    </div>
  )
}

function ThinkingCard({ block, expanded, live }: { block: ReasoningBlock; expanded: boolean; live: boolean }) {
  return (
    <details className="thinking" open={expanded}>
      <summary className="thinking-head">
        <BrainIcon size={12} />
        <span className="thinking-title">思考过程</span>
        <span className="thinking-meta">{live ? '正在思考…' : `${block.text.length} 字`}</span>
      </summary>
      <div className="thinking-body">
        {block.text}
        {live ? <span className="caret" /> : null}
      </div>
    </details>
  )
}

/**
 * A burst of tool calls collapsed into one readable row. It opens itself while a
 * call is still running and closes once the burst finishes, unless the user has
 * taken over the toggle.
 */
function ToolRun({ blocks }: { blocks: ToolBlock[] }) {
  const running = blocks.some(isRunning)
  // `null` means "follow the run": open while something is executing, closed
  // once the burst is over. Any click pins the state until execution resumes.
  const [override, setOverride] = useState<boolean | null>(null)
  const shown = override ?? running

  useEffect(() => {
    if (running) setOverride(null)
  }, [running])

  return (
    <div className={`tool-run ${shown ? 'open' : ''}`}>
      <button
        type="button"
        className="tool-run-head"
        aria-expanded={shown}
        onClick={() => setOverride(!shown)}
      >
        <span className="tool-run-text">{describeToolRun(blocks)}</span>
        {running ? <span className="tool-state running">运行中</span> : null}
        <ChevronDownIcon size={13} />
      </button>
      {shown
        ? (
          <div className="tool-run-body">
            {blocks.map((block, index) => (
              <ToolCard key={block.callId ?? index} block={block} />
            ))}
          </div>
        )
        : null}
    </div>
  )
}

function ToolCard({ block }: { block: ToolBlock }) {
  const running = isRunning(block)
  const detail = toolDetail(block)

  return (
    <details className={`tool ${block.isError ? 'error' : ''}`}>
      <summary className="tool-head">
        <ToolIcon size={13} />
        <span className="tool-name">{detail.title}</span>
        <span className="tool-input">{detail.command ? '' : formatToolInput(block.input, detail.path)}</span>
        {running
          ? <span className="tool-state running">运行中</span>
          : block.isError
            ? <span className="tool-state">failed</span>
            : <span className="tool-meta">{formatOutputSize(block.output)}</span>}
      </summary>
      {detail.command
        ? <pre className="tool-command">$ {detail.command}</pre>
        : detail.path ? <div className="tool-path">{detail.path}</div> : null}
      <pre className="tool-output">{block.output || (block.isError ? 'failed' : 'running…')}</pre>
    </details>
  )
}

function formatOutputSize(output: string) {
  if (!output) return ''
  if (output.length < 1_000) return `${output.length} 字符`
  return `${(output.length / 1_000).toFixed(1)}k 字符`
}

function formatToolInput(raw: string, path?: string) {
  try {
    const value = JSON.parse(raw)
    if (value && typeof value === 'object') {
      const parts = Object.entries(value)
        // The path already leads the title.
        .filter(([key]) => key !== 'path')
        .map(([key, item]) => `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`)
      if (parts.length) return parts.join(' · ')
    }
  } catch {
    // fall through to the raw string
  }
  return path ? '' : raw
}
