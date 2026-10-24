import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ChatSession, ToolBlock } from '@ruobai/chat-protocol'
import { SparkIcon, ToolIcon } from './Icons.tsx'

interface TranscriptProps {
  session: ChatSession | null
  onSuggestion: (text: string) => void
}

const SUGGESTIONS = [
  '解释一下 Cordis 的 fiber 生命周期',
  '帮我看一下 loader 的源码',
  '给 UI 加一个会话搜索',
]

export function Transcript({ session, onSuggestion }: TranscriptProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  const last = session?.messages.at(-1)
  const lastBlock = last?.blocks.at(-1)
  const lastText = lastBlock?.type === 'text' ? lastBlock.text.length : 0

  useEffect(() => {
    const box = boxRef.current
    if (box && pinnedRef.current) box.scrollTop = box.scrollHeight
  }, [session?.id, session?.messages.length, lastText])

  return (
    <div
      className="transcript"
      ref={boxRef}
      onScroll={(event) => {
        const box = event.currentTarget
        pinnedRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 120
      }}
    >
      <div className="transcript-inner">
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
    </div>
  )
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    const text = message.blocks.map(block => block.type === 'text' ? block.text : '').join('')
    return (
      <div className="msg user">
        <div className="bubble">{text}</div>
      </div>
    )
  }

  const toolOnly = message.blocks.length > 0 && message.blocks.every(block => block.type === 'tool')

  return (
    <div className={`msg assistant ${toolOnly ? 'tool-only' : ''}`}>
      <div className="msg-body">
        {message.blocks.map((block, index) => block.type === 'text'
          ? (
            <div className="prose markdown" key={index}>
              <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
              {message.status === 'streaming' && index === message.blocks.length - 1
                ? <span className="caret" />
                : null}
            </div>
          )
          : <ToolCard key={index} block={block} />)}
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
