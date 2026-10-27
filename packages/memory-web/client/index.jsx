/**
 * Long-term memory panel (client half).
 *
 * Lists active and dormant entries with their source, lets a person pin,
 * forget and search, and writes new entries without going through the model.
 */

const STYLES = `
.memory-panel { display: flex; flex-direction: column; gap: 22px; }
.memory-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.memory-stat {
  padding: 11px 13px; border: 1px solid var(--border); border-radius: 11px; background: var(--panel);
}
.memory-stat strong { display: block; font-size: 18px; font-weight: 600; line-height: 1.25; }
.memory-stat span { display: block; margin-top: 2px; color: var(--faint); font-size: 10.5px; }
.memory-stat em { margin-left: 4px; color: var(--muted); font-size: 10.5px; font-style: normal; }
.memory-group { display: flex; flex-direction: column; gap: 8px; }
.memory-group-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 2px; }
.memory-group-label { color: var(--faint); font-size: 11.5px; }
.memory-card { overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); }
.memory-composer { display: flex; flex-direction: column; gap: 9px; padding: 14px 16px; }
.memory-composer textarea {
  min-height: 72px; resize: vertical; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); font: inherit; font-size: 12.5px; line-height: 1.55;
}
.memory-composer textarea:focus { outline: none; border-color: var(--accent); }
.memory-composer-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.memory-field { display: inline-flex; align-items: center; gap: 6px; color: var(--faint); font-size: 11px; }
.memory-field select {
  height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel); color: var(--text); font: inherit; font-size: 12px;
}
.memory-search { display: flex; align-items: center; gap: 6px; min-width: 0; }
.memory-search input {
  flex: 1; width: 210px; min-width: 120px; height: 28px; padding: 0 9px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel); color: var(--text); font: inherit; font-size: 12px;
}
.memory-search input:focus { outline: none; border-color: var(--accent); }
.memory-btn {
  flex: none; white-space: nowrap;
  height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel); color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer;
}
.memory-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.memory-btn:disabled { opacity: .45; cursor: not-allowed; }
.memory-btn-primary { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
.memory-btn-danger:hover:not(:disabled) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.memory-row { display: flex; align-items: flex-start; gap: 18px; padding: 13px 16px; }
.memory-row + .memory-row { border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent); }
.memory-row.dormant { opacity: .55; }
.memory-row-main { display: flex; flex: 1; flex-direction: column; gap: 5px; min-width: 0; }
.memory-row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.memory-text { font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.memory-badge {
  padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent);
  font-size: 10px; font-weight: 500;
}
.memory-badge.scope { background: var(--tool-bg); color: var(--muted); }
.memory-badge.pinned { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }
.memory-badge.dormant { background: transparent; border: 1px solid var(--border); color: var(--faint); }
.memory-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--faint); font-size: 10.5px; }
.memory-actions { display: flex; flex: none; gap: 6px; }
.memory-error { color: var(--danger); font-size: 12px; }
.memory-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 34px 20px; color: var(--faint); font-size: 12px; text-align: center; }
.memory-empty strong { color: var(--text); font-size: 13px; font-weight: 500; }
@media (max-width: 760px) {
  .memory-summary { grid-template-columns: 1fr; }
  .memory-group-head { align-items: flex-start; flex-direction: column; }
  .memory-search { width: 100%; }
  .memory-search input { width: auto; min-width: 0; }
  .memory-row { align-items: stretch; flex-direction: column; gap: 10px; }
  .memory-actions { justify-content: flex-end; }
}
`

const KIND_LABEL = {
  preference: '偏好',
  constraint: '约束',
  decision: '决策',
  fact: '事实',
  gotcha: '坑',
  procedure: '做法',
}
const KINDS = Object.keys(KIND_LABEL)

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById('memory-panel-styles')) return
  const style = document.createElement('style')
  style.id = 'memory-panel-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}
ensureStyles()

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

function relative(ts) {
  if (!ts) return ''
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86400)} 天前`
}


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
    h('div', { className: 'memory-summary' },
      h('div', { className: 'memory-stat' },
        h('strong', null, stats ? stats.items : '—'),
        h('span', null, '条有效记忆')),
      h('div', { className: 'memory-stat' },
        h('strong', null, stats ? stats.injectedChars.toLocaleString() : '—', h('em', null, '字符')),
        h('span', null, `注入预算 ${stats ? stats.budgetTokens : '—'} tokens`)),
      h('div', { className: 'memory-stat' },
        h('strong', null, stats ? `${stats.global} / ${stats.project}` : '—'),
        h('span', null, `全局 / 项目${stats?.dormant ? ` · ${stats.dormant} 条休眠` : ''}`))),

    h('section', { className: 'memory-group' },
      h('div', { className: 'memory-group-head' },
        h('span', { className: 'memory-group-label' }, '添加记忆'),
        h('span', { className: 'memory-group-label' }, '写入后对后续回合生效')),
      h('div', { className: 'memory-card memory-composer' },
        h('textarea', {
          value: text,
          placeholder: '例如：用户偏好中文回复，提交信息用中文摘要。',
          onChange: event => setText(event.target.value),
        }),
        h('div', { className: 'memory-composer-row' },
          h('label', { className: 'memory-field' }, '类型',
            h('select', { value: kind, onChange: event => setKind(event.target.value) },
              KINDS.map(value => h('option', { key: value, value }, KIND_LABEL[value])))),
          h('label', { className: 'memory-field' }, '范围',
            h('select', { value: scope, onChange: event => setScope(event.target.value) },
              h('option', { value: 'project' }, '项目'),
              h('option', { value: 'global' }, '全局'))),
          h('span', { style: { flex: 1 } }),
          h('button', {
            className: 'memory-btn memory-btn-primary',
            disabled: busy || !text.trim(),
            onClick: save,
          }, busy ? '保存中…' : '记住')))),

    h('section', { className: 'memory-group' },
      h('div', { className: 'memory-group-head' },
        h('span', { className: 'memory-group-label' },
          filtered ? `检索结果 ${filtered.length}` : `记忆 ${items.length}`),
        h('div', { className: 'memory-search' },
          h('input', {
            value: search,
            placeholder: '搜索内容或标签',
            onChange: (event) => {
              setSearch(event.target.value)
              if (!event.target.value.trim()) setFiltered(null)
            },
            onKeyDown: event => { if (event.key === 'Enter') void runSearch() },
          }),
          h('button', { className: 'memory-btn', onClick: runSearch }, '搜索'),
          filtered
            ? h('button', {
              className: 'memory-btn',
              onClick: () => {
                setSearch('')
                setFiltered(null)
              },
            }, '清除')
            : null)),

      error ? h('div', { className: 'memory-error' }, error) : null,

      h('div', { className: 'memory-card' },
        items.length
          ? items.map(item =>
            h('div', {
              key: item.id,
              className: `memory-row${item.validTo ? ' dormant' : ''}`,
            },
            h('div', { className: 'memory-row-main' },
              h('div', { className: 'memory-row-head' },
                h('span', { className: 'memory-badge' }, KIND_LABEL[item.kind] || item.kind),
                h('span', { className: 'memory-badge scope' }, item.scope === 'global' ? '全局' : '项目'),
                item.pinned ? h('span', { className: 'memory-badge pinned' }, '已固定') : null,
                item.validTo ? h('span', { className: 'memory-badge dormant' }, '已失效') : null),
              h('div', { className: 'memory-text' }, item.text),
              h('div', { className: 'memory-meta' },
                h('span', null, `更新于 ${relative(item.updatedAt)}`),
                h('span', null, `置信度 ${item.confidence}`),
                h('span', null, `命中 ${item.hits}`),
                item.source?.sessionId
                  ? h('span', null, `来源会话 ${String(item.source.sessionId).slice(0, 8)}`)
                  : null)),
            h('div', { className: 'memory-actions' },
              h('button', { className: 'memory-btn', onClick: () => togglePin(item) },
                item.pinned ? '取消固定' : '固定'),
              h('button', { className: 'memory-btn memory-btn-danger', onClick: () => forget(item) }, '遗忘'))))
          : h('div', { className: 'memory-empty' },
            h('strong', null, search ? '没有匹配的记忆' : '还没有长期记忆'),
            h('span', null, search
              ? '换一个关键词，或清除检索看全部。'
              : '用 /remember 让模型记住，或在上面的输入框添加。')))))
}

export default function register(api) {
  api.slots.register('settings.memory', {
    id: 'memory.settings',
    component: props => MemoryPanel(api, props),
  })
}
