import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ChatSession, ToolBlock } from '@ruobai/chat-protocol'
import { ChevronDownIcon, SparkIcon, ToolIcon } from './Icons.tsx'
import { AttachmentRail } from './AttachmentRail.tsx'
import { useContextMenu } from './ContextMenu.tsx'
import { TurnNav } from './TurnNav.tsx'

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

  const last = session?.messages.at(-1)
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
    const lastMessage = session?.messages.at(-1)
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
  }, [session?.id, session?.messages.length, lastText])

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
          ) : session.messages.length === 0 ? (
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

          {session?.messages.map(message => <Message key={message.id} message={message} />)}
        </div>

        {!atBottom && session?.messages.length
          ? (
            <div className="to-bottom-slot">
              <button className="to-bottom" onClick={scrollToBottom} aria-label="回到底部" title="回到底部">
                <ChevronDownIcon size={16} />
              </button>
            </div>
          )
          : null}
      </div>
      <TurnNav containerRef={boxRef} messages={session?.messages ?? []} />
    </div>
  )
}

function Message({ message }: { message: ChatMessage }) {
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

  const toolOnly = message.blocks.length > 0 && message.blocks.every(block => block.type === 'tool')

  return (
    <div className={`msg assistant ${toolOnly ? 'tool-only' : ''}`} onContextMenu={onContextMenu}>
      <div className="msg-body">
        {message.blocks.map((block, index) => {
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
          if (block.type === 'tool') return <ToolCard key={index} block={block} />
          return null
        })}
        {message.status === 'streaming' && message.blocks.length === 0
          ? <div className="prose thinking"><span className="caret" /> Thinking</div>
          : null}
      </div>
    </div>
  )
}

function ToolCard({ block }: { block: ToolBlock }) {
  return (
    <details className={`tool ${block.isError ? 'error' : ''}`}>
      <summary className="tool-head">
        <ToolIcon size={13} />
        <span className="tool-name">{block.name}</span>
        <span className="tool-input">{formatToolInput(block.input)}</span>
        {block.isError ? <span className="tool-state">failed</span> : null}
      </summary>
      <pre className="tool-output">{block.output || (block.isError ? 'failed' : 'running…')}</pre>
    </details>
  )
}

function formatToolInput(raw: string) {
  try {
    const value = JSON.parse(raw)
    if (value && typeof value === 'object') {
      const parts = Object.entries(value).map(([key, item]) =>
        `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`)
      if (parts.length) return parts.join(' · ')
    }
  } catch {
    // fall through to the raw string
  }
  return raw
}
