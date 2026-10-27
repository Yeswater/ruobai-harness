/**
 * Long-term memory panel (client half).
 *
 * Lists active and dormant entries with their source, lets a person pin,
 * forget and search, and writes new entries without going through the model.
 */

const STYLES = `
.memory-panel { display: flex; flex-direction: column; gap: 14px; }
.memory-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11.5px; color: var(--muted); }
.memory-composer { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.memory-composer textarea {
  min-height: 58px; resize: vertical; padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text); font: inherit; font-size: 12.5px;
}
.memory-composer-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.memory-composer select, .memory-search input {
  height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text); font: inherit; font-size: 12px;
}
.memory-search { display: flex; gap: 8px; }
.memory-search input { flex: 1; }
.memory-btn {
  height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer;
}
.memory-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.memory-btn:disabled { opacity: .45; cursor: not-allowed; }
.memory-btn-primary { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
.memory-btn-danger:hover:not(:disabled) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.memory-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.memory-item {
  display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
}
.memory-item.dormant { opacity: .55; }
.memory-item-text { font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.memory-item-meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--faint); }
.memory-badge {
  display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent); font-size: 10.5px;
}
.memory-actions { display: flex; gap: 4px; align-items: start; }
.memory-error { color: var(--danger); font-size: 12px; }
.memory-empty { color: var(--faint); font-size: 12px; }
`

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById('memory-panel-styles')) return
  const style = document.createElement('style')
  style.id = 'memory-panel-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

const KINDS = ['preference', 'constraint', 'decision', 'fact', 'gotcha', 'procedure']

function MemoryPanel(api, props) {
  const { React, h } = api
  const { useState, useEffect } = React
  const sessionId = props?.sessionId
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const [data, setData] = useState(null)
  const [text, setText] = useState('')
  const [kind, setKind] = useState('fact')
  const [scope, setScope] = useState('project')
  const [search, setSearch] = useState('')
  const [filtered, setFiltered] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setError(null)
    try {
      setData(await request(`/api/memory${query}`))
      setFiltered(null)
    } catch (caught) {
      setError(caught.message)
    }
  }

  useEffect(() => {
    void load()
  }, [sessionId])

  const save = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await request(`/api/memory${query}`, {
        method: 'POST',
        body: JSON.stringify({ text, kind, scope }),
      })
      setText('')
      await load()
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (item) => {
    try {
      await request(`/api/memory/${encodeURIComponent(item.id)}/pin${query}`, {
        method: 'POST',
        body: JSON.stringify({ pinned: !item.pinned }),
      })
      await load()
    } catch (caught) {
      setError(caught.message)
    }
  }

  const forget = async (item) => {
    if (!window.confirm(`遗忘这条记忆？\n\n${item.text}`)) return
    try {
      await request(`/api/memory/${encodeURIComponent(item.id)}${query}`, { method: 'DELETE' })
      await load()
    } catch (caught) {
      setError(caught.message)
    }
  }

  const runSearch = async () => {
    if (!search.trim()) {
      setFiltered(null)
      return
    }
    try {
      const result = await request(`/api/memory/search?q=${encodeURIComponent(search)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`)
      setFiltered(result.items)
    } catch (caught) {
      setError(caught.message)
    }
  }

  const stats = data?.stats
  const items = filtered ?? data?.items ?? []

  return h('div', { className: 'memory-panel' },
    h('div', { className: 'memory-stats' },
      stats
        ? [
          h('span', { key: 'count' }, `${stats.items} 条有效记忆`),
          h('span', { key: 'scopes' }, `global ${stats.global} · project ${stats.project}`),
          h('span', { key: 'budget' }, `注入 ${stats.injectedChars} 字符 / 预算 ${stats.budgetTokens} tokens`),
          stats.dormant ? h('span', { key: 'dormant' }, `休眠 ${stats.dormant}`) : null,
          stats.dropped ? h('span', { key: 'dropped' }, `预算外 ${stats.dropped}`) : null,
        ]
        : h('span', null, '加载中…')),

    h('div', { className: 'memory-composer' },
      h('textarea', {
        value: text,
        placeholder: '例如：用户偏好中文回复，提交信息用中文摘要。',
        onChange: event => setText(event.target.value),
      }),
      h('div', { className: 'memory-composer-row' },
        h('select', { value: kind, onChange: event => setKind(event.target.value) },
          KINDS.map(value => h('option', { key: value, value }, value))),
        h('select', { value: scope, onChange: event => setScope(event.target.value) },
          h('option', { value: 'project' }, 'project'),
          h('option', { value: 'global' }, 'global')),
        h('span', { className: 'spacer', style: { flex: 1 } }),
        h('button', { className: 'memory-btn memory-btn-primary', disabled: busy || !text.trim(), onClick: save }, busy ? '保存中…' : '记住'))),

    h('div', { className: 'memory-search' },
      h('input', {
        value: search,
        placeholder: '搜索记忆内容或标签',
        onChange: event => setSearch(event.target.value),
        onKeyDown: event => { if (event.key === 'Enter') void runSearch() },
      }),
      h('button', { className: 'memory-btn', onClick: runSearch }, '搜索')),

    error ? h('div', { className: 'memory-error' }, error) : null,

    items.length
      ? h('ul', { className: 'memory-list' }, items.map(item =>
        h('li', {
          key: item.id,
          className: `memory-item${item.validTo ? ' dormant' : ''}`,
        },
        h('div', { className: 'memory-item-text' },
          h('span', { className: 'memory-badge' }, item.kind),
          item.text),
        h('div', { className: 'memory-actions' },
          h('button', { className: 'memory-btn', onClick: () => togglePin(item) }, item.pinned ? '取消固定' : '固定'),
          h('button', { className: 'memory-btn memory-btn-danger', onClick: () => forget(item) }, '遗忘')),
        h('div', { className: 'memory-item-meta' },
          h('span', null, item.scope),
          h('span', null, item.pinned ? '已固定' : `置信度 ${item.confidence}`),
          item.validTo ? h('span', null, '已失效') : null,
          item.source?.sessionId ? h('span', null, `来源会话 ${String(item.source.sessionId).slice(0, 8)}`) : null,
          h('span', null, `命中 ${item.hits}`)))))
      : h('div', { className: 'memory-empty' }, search ? '没有匹配的记忆。' : '还没有长期记忆。用 /remember 或上面的输入框添加。'))
}

export default function register(api) {
  api.slots.register('settings.memory', {
    id: 'memory.settings',
    component: props => MemoryPanel(api, props),
  })
}
