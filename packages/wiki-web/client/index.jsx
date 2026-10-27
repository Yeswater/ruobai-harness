/**
 * Wiki panel (client half): browse, search, edit, review proposals and inspect
 * history. Markdown stays the source of truth; this is only a door to it.
 */

const STYLES = `
.wiki-panel { display: flex; flex-direction: column; gap: 12px; }
.wiki-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11.5px; color: var(--muted); }
.wiki-toolbar { display: flex; gap: 8px; }
.wiki-toolbar input {
  flex: 1; height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text); font: inherit; font-size: 12px;
}
.wiki-btn {
  height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer;
}
.wiki-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.wiki-btn:disabled { opacity: .45; cursor: not-allowed; }
.wiki-btn-primary { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
.wiki-btn-danger:hover:not(:disabled) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.wiki-grid { display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 720px) { .wiki-grid { grid-template-columns: minmax(0, 1fr); } }
.wiki-side { display: flex; flex-direction: column; gap: 8px; }
.wiki-side h4 { margin: 4px 0 0; font-size: 11px; font-weight: 600; color: var(--muted); }
.wiki-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wiki-page-item {
  width: 100%; text-align: left; padding: 7px 9px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel); color: var(--text); font: inherit; cursor: pointer;
}
.wiki-page-item.active { border-color: var(--accent); background: var(--accent-soft); }
.wiki-page-item strong { display: block; font-size: 12.5px; font-weight: 600; }
.wiki-page-item span { display: block; margin-top: 2px; font-size: 11px; color: var(--muted); }
.wiki-detail { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.wiki-detail input.wiki-title {
  height: 30px; padding: 0 9px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text); font: inherit; font-size: 13px; font-weight: 600;
}
.wiki-detail textarea {
  min-height: 280px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 12px; line-height: 1.55;
}
.wiki-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.wiki-meta { font-size: 11px; color: var(--faint); }
.wiki-warn { color: var(--warn); font-size: 11.5px; }
.wiki-error { color: var(--danger); font-size: 12px; }
.wiki-empty { color: var(--faint); font-size: 12px; }
.wiki-findings { list-style: none; margin: 0; padding: 0; font-size: 11.5px; color: var(--muted); }
.wiki-findings li { padding: 3px 0; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.wiki-proposal { display: flex; gap: 6px; align-items: center; }
.wiki-proposal span { flex: 1; font-size: 11.5px; }
.wiki-version { display: flex; gap: 6px; flex-wrap: wrap; }
.wiki-snippet { white-space: pre-wrap; font-family: var(--mono); font-size: 11px; color: var(--muted); }
`

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById('wiki-panel-styles')) return
  const style = document.createElement('style')
  style.id = 'wiki-panel-styles'
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

function WikiPanel(api, props) {
  const { React, h } = api
  const { useState, useEffect } = React
  const sessionId = props?.sessionId
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const [data, setData] = useState(null)
  const [results, setResults] = useState(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [selected, setSelected] = useState(null)
  const [draft, setDraft] = useState({ title: '', body: '', tags: '' })
  const [backlinks, setBacklinks] = useState([])
  const [versions, setVersions] = useState([])
  const [historical, setHistorical] = useState(null)
  const [findings, setFindings] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setError(null)
    try {
      setData(await request(`/api/wiki${query}`))
    } catch (caught) {
      setError(caught.message)
    }
  }

  useEffect(() => {
    void load()
  }, [sessionId])

  const open = async (id) => {
    setError(null)
    setHistorical(null)
    try {
      const page = await request(`/api/wiki/page/${encodeURIComponent(id)}${query}`)
      setSelected({ ...page, id })
      setDraft({ title: page.meta.title, body: page.body, tags: (page.meta.tags ?? []).join(', ') })
      const [links, history] = await Promise.all([
        request(`/api/wiki/page/${encodeURIComponent(id)}/backlinks${query}`),
        request(`/api/wiki/page/${encodeURIComponent(id)}/versions${query}`),
      ])
      setBacklinks(links.backlinks ?? [])
      setVersions(history.versions ?? [])
    } catch (caught) {
      setError(caught.message)
    }
  }

  const newPage = () => {
    setSelected({ id: null, meta: { revision: 0, status: 'draft', tags: [] }, body: '', stale: [] })
    setDraft({ title: '', body: '', tags: '' })
    setBacklinks([])
    setVersions([])
    setHistorical(null)
    setNotice(null)
  }

  const save = async () => {
    setBusy(true)
    try {
      const tags = draft.tags.split(',').map(value => value.trim()).filter(Boolean)
      const result = selected?.id
        ? await request(`/api/wiki/page/${encodeURIComponent(selected.id)}${query}`, {
          method: 'PUT',
          body: JSON.stringify({ title: draft.title, body: draft.body, tags }),
        })
        : await request(`/api/wiki/page${query}`, {
          method: 'POST',
          body: JSON.stringify({ title: draft.title, body: draft.body, tags }),
        })
      setNotice(`已保存 ${result.id} · r${result.revision}`)
      await load()
      await open(result.id)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  const archive = async () => {
    if (!selected || !window.confirm(`归档页面 ${selected.id}？`)) return
    try {
      await request(`/api/wiki/page/${encodeURIComponent(selected.id)}${query}`, { method: 'DELETE' })
      setSelected(null)
      setNotice('已归档')
      await load()
    } catch (caught) {
      setError(caught.message)
    }
  }

  const runSearch = async () => {
    if (!search.trim()) {
      setResults(null)
      return
    }
    try {
      setResults(await request(`/api/wiki/search?q=${encodeURIComponent(search)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`))
    } catch (caught) {
      setError(caught.message)
    }
  }

  const runLint = async () => {
    try {
      const result = await request(`/api/wiki/lint${query}`)
      setFindings(result.findings ?? [])
    } catch (caught) {
      setError(caught.message)
    }
  }

  const accept = async (name) => {
    try {
      await request(`/api/wiki/proposals/${encodeURIComponent(name)}/accept${query}`, { method: 'POST' })
      setNotice(`已接受提案 ${name}`)
      await load()
    } catch (caught) {
      setError(caught.message)
    }
  }

  const reject = async (name) => {
    if (!window.confirm(`拒绝提案 ${name}？`)) return
    try {
      await request(`/api/wiki/proposals/${encodeURIComponent(name)}${query}`, { method: 'DELETE' })
      await load()
    } catch (caught) {
      setError(caught.message)
    }
  }

  const openVersion = async (revision) => {
    if (!selected) return
    try {
      const result = await request(`/api/wiki/page/${encodeURIComponent(selected.id)}/versions/${revision}${query}`)
      setHistorical({ revision, text: result.text })
    } catch (caught) {
      setError(caught.message)
    }
  }

  const diffLatest = async () => {
    if (!selected || versions.length < 2) return
    try {
      const from = versions[versions.length - 2]
      const to = versions[versions.length - 1]
      const result = await request(`/api/wiki/page/${encodeURIComponent(selected.id)}/diff?from=${from}&to=${to}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`)
      setHistorical({ revision: `${from}..${to}`, text: result.diff })
    } catch (caught) {
      setError(caught.message)
    }
  }

  const stats = data?.stats
  const pages = data?.pages ?? []
  const proposals = data?.proposals ?? []

  return h('div', { className: 'wiki-panel' },
    h('div', { className: 'wiki-stats' },
      stats
        ? [
          h('span', { key: 'pages' }, `${stats.pages} 页 · ${stats.chunks} 块`),
          h('span', { key: 'ready' }, `可检索 ${stats.ready}`),
          stats.unready ? h('span', { key: 'unready' }, `未就绪 ${stats.unready}`) : null,
          h('span', { key: 'catalog' }, `目录 ${stats.catalogChars} 字符`),
        ]
        : h('span', null, '加载中…')),

    h('div', { className: 'wiki-toolbar' },
      h('input', {
        value: search,
        placeholder: '检索页面（BM25，支持中文）',
        onChange: event => setSearch(event.target.value),
        onKeyDown: event => { if (event.key === 'Enter') void runSearch() },
      }),
      h('button', { className: 'wiki-btn', onClick: runSearch }, '检索'),
      h('button', { className: 'wiki-btn', onClick: runLint }, '检查'),
      h('button', { className: 'wiki-btn', onClick: () => void load() }, '刷新')),

    error ? h('div', { className: 'wiki-error' }, error) : null,
    notice ? h('div', { className: 'wiki-meta' }, notice) : null,

    results
      ? h('div', null,
        h('div', { className: 'wiki-meta' }, results.hits.length ? `检索结果 ${results.hits.length}${results.truncated ? '+' : ''}` : '没有匹配的页面。'),
        h('ul', { className: 'wiki-list' }, results.hits.map(hit =>
          h('li', { key: `${hit.page}-${hit.heading}` },
            h('button', { className: 'wiki-page-item', onClick: () => open(hit.page) },
              h('strong', null, `${hit.page} › ${hit.heading}`),
              h('span', null, hit.summary || hit.snippet))))))
      : null,

    findings
      ? h('div', null,
        h('div', { className: 'wiki-meta' }, findings.length ? `检查发现 ${findings.length} 项` : '没有发现问题。'),
        h('ul', { className: 'wiki-findings' }, findings.slice(0, 20).map((finding, index) =>
          h('li', { key: index }, `${finding.page ? `${finding.page}: ` : ''}[${finding.kind}] ${finding.detail}`))))
      : null,

    h('div', { className: 'wiki-grid' },
      h('div', { className: 'wiki-side' },
        h('div', { className: 'wiki-row' },
          h('h4', null, '页面'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'wiki-btn', onClick: newPage }, '新建')),
        pages.length
          ? h('ul', { className: 'wiki-list' }, pages.map(page =>
            h('li', { key: page.id },
              h('button', {
                className: `wiki-page-item${selected?.id === page.id ? ' active' : ''}`,
                onClick: () => open(page.id),
              },
              h('strong', null, page.title),
              h('span', null, `${page.id} · ${page.status}${page.sourced ? '' : ' · 未溯源'}`)))))
          : h('div', { className: 'wiki-empty' }, '还没有页面。用 /wiki save 生成提案，或直接在右侧新建。'),

        proposals.length ? h('h4', null, `待审提案（${proposals.length}）`) : null,
        proposals.length
          ? h('ul', { className: 'wiki-list' }, proposals.map(proposal =>
            h('li', { key: proposal.id, className: 'wiki-proposal' },
              h('span', null, proposal.title),
              h('button', { className: 'wiki-btn', onClick: () => accept(proposal.id) }, '接受'),
              h('button', { className: 'wiki-btn wiki-btn-danger', onClick: () => reject(proposal.id) }, '拒绝'))))
          : null),

      h('div', { className: 'wiki-detail' },
        selected
          ? [
            h('input', {
              key: 'title',
              className: 'wiki-title',
              value: draft.title,
              onChange: event => setDraft({ ...draft, title: event.target.value }),
            }),
            h('input', {
              key: 'tags',
              className: 'wiki-title',
              value: draft.tags,
              placeholder: '标签，逗号分隔',
              onChange: event => setDraft({ ...draft, tags: event.target.value }),
            }),
            selected.stale?.length
              ? h('div', { key: 'stale', className: 'wiki-warn' },
                `来源已变化：${selected.stale.map(item => `${item.path}（${item.reason === 'missing' ? '缺失' : '已变化'}）`).join('、')}`)
              : null,
            h('textarea', {
              key: 'body',
              value: draft.body,
              onChange: event => setDraft({ ...draft, body: event.target.value }),
            }),
            h('div', { key: 'actions', className: 'wiki-row' },
              h('button', { className: 'wiki-btn wiki-btn-primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
              h('button', { className: 'wiki-btn wiki-btn-danger', onClick: archive }, '归档'),
              h('span', { className: 'wiki-meta' }, `r${selected.meta.revision} · ${selected.meta.status} · 反链 ${backlinks.length}`)),
            backlinks.length
              ? h('div', { key: 'backlinks', className: 'wiki-meta' },
                `反链：${backlinks.map(link => link.id).join('、')}`)
              : null,
            versions.length
              ? h('div', { key: 'versions', className: 'wiki-version' },
                h('span', { className: 'wiki-meta' }, '历史版本：'),
                versions.map(revision =>
                  h('button', {
                    key: revision,
                    className: 'wiki-btn',
                    onClick: () => openVersion(revision),
                  }, `r${revision}`)),
                versions.length >= 2
                  ? h('button', { className: 'wiki-btn', onClick: diffLatest }, '对比最近两版')
                  : null)
              : null,
            historical
              ? h('div', { key: 'historical' },
                h('div', { className: 'wiki-meta' }, `版本 ${historical.revision}（只读）`),
                h('pre', { className: 'wiki-snippet' }, historical.text))
              : null,
          ]
          : h('div', { className: 'wiki-empty' },
            '选择一个页面查看或编辑。也可以直接新建：填写标题和正文后保存；id 由标题生成。')))
}

export default function register(api) {
  api.slots.register('settings.wiki', {
    id: 'wiki.settings',
    component: props => WikiPanel(api, props),
  })
}
