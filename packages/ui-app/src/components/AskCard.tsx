import { useState } from 'react'
import type { AskRequest } from '../api.ts'

interface AskCardProps {
  request: AskRequest
  onAnswer: (answer: string) => void
}

/** A blocking question from the agent. Options are shortcuts, not a closed set. */
export function AskCard({ request, onAnswer }: AskCardProps) {
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const submit = () => {
    const value = text.trim()
    if (value) onAnswer(value)
  }
  // Verified facts belong in the question, but the card is not a report: long
  // questions open clamped so the choices stay on screen.
  const long = request.question.length > 160 || request.question.split('\n').length > 3

  return (
    <div className="approval ask">
      <div className="approval-head">
        <span className="approval-title">需要你决定</span>
      </div>

      <div className={long && !expanded ? 'ask-question clamped' : 'ask-question'}>
        {request.question}
      </div>
      {long ? (
        <button className="ask-toggle" onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起' : '展开全部'}
        </button>
      ) : null}

      {request.options?.length ? (
        <div className="ask-options">
          {request.options.map(option => (
            <button key={option} className="btn ghost" onClick={() => onAnswer(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {request.allowFreeText ? (
        <div className="ask-input">
          <input
            value={text}
            placeholder={request.options?.length ? '或者直接输入回答…' : '输入回答…'}
            onChange={event => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button className="btn" disabled={!text.trim()} onClick={submit}>回答</button>
        </div>
      ) : null}
    </div>
  )
}
