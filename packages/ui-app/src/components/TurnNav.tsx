import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ChatMessage } from '@ruobai/chat-protocol'

interface TurnNavProps {
  containerRef: RefObject<HTMLElement | null>
  messages: ChatMessage[]
}

interface Turn {
  id: string
  title: string
  excerpt: string
}

function textOf(message: ChatMessage) {
  return message.blocks.map(block => block.type === 'text' ? block.text : '').join('').trim()
}

function buildTurns(messages: ChatMessage[]): Turn[] {
  const turns: Array<{ id: string; user: string; assistant: string }> = []
  let current: { id: string; user: string; assistant: string } | null = null

  for (const message of messages) {
    if (message.role === 'user') {
      current = { id: message.id, user: textOf(message), assistant: '' }
      turns.push(current)
    } else if (current && message.role === 'assistant') {
      const text = textOf(message)
      if (text) current.assistant += `${current.assistant ? '\n' : ''}${text}`
    }
  }

  return turns.map((turn) => {
    const user = turn.user.replace(/\s+/g, ' ').trim()
    const assistant = turn.assistant.replace(/\s+/g, ' ').trim()
    return {
      id: turn.id,
      title: user.slice(0, 140),
      excerpt: (assistant || user.slice(140)).slice(0, 420),
    }
  })
}

export function TurnNav({ containerRef, messages }: TurnNavProps) {
  const turns = buildTurns(messages)
  const turnsRef = useRef(turns)
  turnsRef.current = turns

  const [active, setActive] = useState(0)
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    const box = containerRef.current
    if (!box) return

    const update = () => {
      const viewportTop = box.getBoundingClientRect().top
      const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight
      let current = 0
      for (let index = 0; index < turnsRef.current.length; index += 1) {
        const element = document.getElementById(`msg-${turnsRef.current[index]!.id}`)
        if (element && element.getBoundingClientRect().top - viewportTop <= 24) current = index
      }
      // At the very bottom the last turn wins even when its message sits above
      // the top anchor; at the top the first turn wins.
      if (distanceFromBottom <= 24) current = turnsRef.current.length - 1
      setActive(current)
    }

    update()
    box.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(box)
    window.addEventListener('resize', update)
    return () => {
      box.removeEventListener('scroll', update)
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [containerRef, turns.length])

  if (turns.length < 2) return null

  const jump = (id: string) => {
    const box = containerRef.current
    const element = document.getElementById(`msg-${id}`)
    if (!box || !element) return
    const top = element.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12
    box.scrollTop = Math.max(0, Math.min(top, Math.max(0, box.scrollHeight - box.clientHeight)))
    box.dispatchEvent(new Event('scroll'))
  }

  return (
    <nav className="turn-nav" aria-label="Conversation turns">
      {turns.map((turn, index) => (
        <div
          key={turn.id}
          className="turn-nav-item"
          role="button"
          tabIndex={0}
          aria-label={`Jump to turn ${index + 1}`}
          onMouseEnter={() => setHovered(turn.id)}
          onMouseLeave={() => setHovered(null)}
          onClick={() => {
            setActive(index)
            jump(turn.id)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setActive(index)
              jump(turn.id)
            }
          }}
        >
          <span
            className={`turn-nav-mark ${index === active ? 'active' : ''}`}
            aria-hidden="true"
          />
          {hovered === turn.id ? (
            <div className="turn-nav-card" role="tooltip">
              <div className="turn-nav-title">{turn.title}</div>
              {turn.excerpt ? <div className="turn-nav-body">{turn.excerpt}</div> : null}
            </div>
          ) : null}
        </div>
      ))}
    </nav>
  )
}
