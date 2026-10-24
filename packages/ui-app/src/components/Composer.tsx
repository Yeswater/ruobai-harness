import { useEffect, useRef, useState } from 'react'
import type { ModeInfo } from '../api.ts'
import { SendIcon, StopIcon } from './Icons.tsx'

interface ComposerProps {
  disabled: boolean
  streaming: boolean
  model: string
  modes: ModeInfo[]
  mode: string
  onModeChange: (mode: string) => void
  onSend: (text: string) => void
  onStop: () => void
}

export function Composer({ disabled, streaming, model, modes, mode, onModeChange, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }, [text])

  const submit = () => {
    const value = text.trim()
    if (!value || disabled || streaming) return
    setText('')
    onSend(value)
  }

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          placeholder={disabled ? '正在加载会话…' : '给 harness 发一条消息…'}
          onChange={event => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-left">
            {modes.length
              ? (
                <select
                  className="mode-select"
                  value={mode}
                  onChange={event => onModeChange(event.target.value)}
                  disabled={streaming}
                  title={modes.find(item => item.id === mode)?.description}
                >
                  {modes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              )
              : null}
            <span className="chip">{model}</span>
          </div>
          <div className="composer-actions">
            <span className="hint">Enter 发送 · Shift+Enter 换行</span>
            {streaming
              ? (
                <button type="button" className="send stop" onClick={onStop} aria-label="Stop">
                  <StopIcon size={14} />
                </button>
              )
              : (
                <button type="submit" className="send" disabled={disabled || !text.trim()} aria-label="Send">
                  <SendIcon size={16} />
                </button>
              )}
          </div>
        </div>
      </form>
    </div>
  )
}
