import { useState } from 'react'
import type { TodoSnapshot } from '../api.ts'

interface TodoPanelProps {
  todo: TodoSnapshot | null
}

/**
 * The model's task list for the active session.
 *
 * Read-only: the model owns the list through `todo_write`, and the user edits
 * work by talking to it. Rendering nothing when the list is empty keeps the
 * composer area unchanged for single-step sessions.
 */
export function TodoPanel({ todo }: TodoPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const items = todo?.items ?? []
  if (!items.length) return null

  const done = items.filter(item => item.status === 'completed').length
  const active = items.find(item => item.status === 'in_progress')

  return (
    <section className="todo-panel" aria-label="任务清单">
      <button
        type="button"
        className="todo-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(value => !value)}
      >
        <span className="todo-count">{done}/{items.length}</span>
        <span className="todo-title">{active ? active.text : '任务清单'}</span>
        <span className="todo-hint">{collapsed ? '展开' : '收起'}</span>
      </button>
      {collapsed
        ? null
        : (
          <ol className="todo-list">
            {items.map(item => (
              <li key={item.id} className={`todo-item is-${item.status}`}>
                <span className="todo-mark" aria-hidden />
                <span className="todo-text">{item.text}</span>
              </li>
            ))}
          </ol>
        )}
    </section>
  )
}
