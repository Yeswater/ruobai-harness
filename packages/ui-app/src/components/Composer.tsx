import { useEffect, useRef, useState } from 'react'
import type { ModeInfo } from '../api.ts'
import { SendIcon, StopIcon } from './Icons.tsx'
import { Select } from './Select.tsx'

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
    textarea.style.height = 'auto'
    const next = Math.min(textarea.scrollHeight, 240)
    textarea.style.height = `${next}px`
    textarea.style.overflowY = textarea.scrollHeight > 240 ? 'auto' : 'hidden'
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
                <Select
                  className="mode-select"
                  value={mode}
                  options={modes.map(item => ({
                    value: item.id,
                    label: item.name,
                    description: item.description,
                  }))}
                  onChange={onModeChange}
                  disabled={streaming}
                  ariaLabel="Agent mode"
                  menuWidth={260}
                />
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
